import { NwcClient, inspectNwcConnection } from '@forgesworn/nwc-kit'
import type { NwcTransport } from '@forgesworn/nwc-kit'
import { tryDecodeBolt11, verifyInvoiceCommitment, verifyPreimage } from 'farrier-kit'
import type { LightningBackend, Invoice, InvoiceStatus } from '../types.js'

export interface NwcConfig {
  /** Merchant-owned NWC connection URI. Treat it as a bearer credential. */
  nwcUrl: string
  /** Request and response timeout in ms (default: 60000). */
  timeout?: number
  /** Custom transport for controlled runtimes and deterministic tests. */
  transport?: NwcTransport
}

/**
 * Merchant Lightning backend over Nostr Wallet Connect (NIP-47).
 *
 * This is a backend connector, not a payment rail and not a payer-wallet
 * endpoint. The configured URI belongs to the merchant and never crosses an
 * HTTP request boundary. NIP-44 v2 capability discovery and authenticated
 * responses are enforced by @forgesworn/nwc-kit; BOLT-11 commitments and
 * settlement preimages are independently checked with farrier-kit.
 */
export function nwcBackend(config: NwcConfig): LightningBackend {
  const { nwcUrl, timeout, transport } = config

  // Validate at startup without retaining or exposing secret material.
  inspectNwcConnection(nwcUrl)

  let client: NwcClient | undefined
  function getClient(): NwcClient {
    client ??= new NwcClient(nwcUrl, {
      ...(timeout !== undefined ? { requestTimeoutMs: timeout, infoTimeoutMs: timeout } : {}),
      ...(transport ? { transport } : {}),
    })
    return client
  }

  return {
    async createInvoice(amountSats: number, memo?: string): Promise<Invoice> {
      if (
        !Number.isSafeInteger(amountSats) ||
        amountSats <= 0 ||
        amountSats > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
      ) {
        throw new Error('NWC createInvoice amount must be a positive safe integer')
      }
      const transaction = await getClient().makeInvoice({
        amount: amountSats * 1000,
        ...(memo !== undefined ? { description: memo } : {}),
      })
      if (!transaction.invoice || !transaction.payment_hash) {
        throw new Error('NWC response missing invoice or payment_hash')
      }
      const commitment = verifyInvoiceCommitment({
        bolt11: transaction.invoice,
        paymentHash: transaction.payment_hash,
        expectedMsats: BigInt(amountSats) * 1000n,
      })
      if (!commitment.ok) {
        throw new Error(`NWC returned an invoice that violates the requested commitment: ${commitment.reason}`)
      }
      return { bolt11: transaction.invoice, paymentHash: transaction.payment_hash }
    },

    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      if (!/^[0-9a-f]{64}$/i.test(paymentHash)) return { paid: false }
      try {
        const transaction = await getClient().lookupInvoice({ payment_hash: paymentHash })
        if (transaction.state !== 'settled' || !transaction.preimage) return { paid: false }
        if (!verifyPreimage(transaction.preimage, paymentHash)) return { paid: false }
        return { paid: true, preimage: transaction.preimage }
      } catch {
        return { paid: false }
      }
    },

    async sendPayment(bolt11: string): Promise<{ preimage: string }> {
      const decoded = tryDecodeBolt11(bolt11)
      if (!decoded) throw new Error('NWC sendPayment: invalid BOLT-11 invoice')
      const result = await getClient().payInvoice({ invoice: bolt11 })
      if (!verifyPreimage(result.preimage, decoded.paymentHashHex)) {
        throw new Error('NWC sendPayment: wallet returned a non-settling preimage')
      }
      return { preimage: result.preimage }
    },
  }
}
