import type { LightningBackend, Invoice, InvoiceStatus } from '../types.js'
import type { NWCClient } from './nwc-client.js'

export interface NwcConfig {
  /** NWC connection URI: nostr+walletconnect://pubkey?relay=wss://...&secret=... */
  nwcUrl: string
  /** Reply timeout in ms (default: 60000) */
  timeout?: number
}

/**
 * Lightning backend adapter for Nostr Wallet Connect (NIP-47).
 *
 * Works with any NWC-compatible wallet (Alby Hub, Mutiny, Umbrel,
 * Phoenix, and others). Communication is end-to-end encrypted over
 * Nostr relays using NIP-44 (or NIP-04 for older wallets).
 *
 * The NWC client (`nwc-client.ts`, built on nostr-tools) is imported
 * dynamically so the Nostr stack is only loaded when this backend is
 * actually used.
 *
 * Security: wallet response events are signature-verified and matched to
 * the wallet pubkey and request ID before being trusted (relay author
 * filters are not authentication). nostr-tools' relay layer already
 * verifies event signatures; the NWC client re-checks the author, request
 * reference and signature as defence-in-depth, plus emits a one-time
 * stderr warning when the wallet only supports NIP-04 (AES-CBC, no MAC).
 *
 * @see https://nwc.dev/
 * @see https://github.com/nostr-protocol/nips/blob/master/47.md
 */
export function nwcBackend(config: NwcConfig): LightningBackend {
  const { nwcUrl, timeout } = config

  // Validate the connection string eagerly so config errors surface at startup
  if (!nwcUrl || !nwcUrl.startsWith('nostr+walletconnect://')) {
    throw new Error('NWC URL must start with nostr+walletconnect://')
  }

  // Lazy-initialised client — connects on first use
  let clientPromise: Promise<NWCClient> | undefined

  async function getClient() {
    if (!clientPromise) {
      clientPromise = (async () => {
        const { NWCClient } = await import('./nwc-client.js')
        const nwc = new NWCClient(nwcUrl)
        if (timeout !== undefined) {
          nwc.replyTimeout = timeout
        }
        await nwc.connect()
        return nwc
      })()
    }
    return clientPromise
  }

  return {
    async createInvoice(amountSats: number, memo?: string): Promise<Invoice> {
      const nwc = await getClient()
      const tx = await nwc.makeInvoice({
        amount: amountSats * 1000, // NWC uses millisatoshis
        description: memo,
      })

      if (!tx.invoice || !tx.payment_hash) {
        throw new Error('NWC response missing invoice or payment_hash')
      }

      return { bolt11: tx.invoice, paymentHash: tx.payment_hash }
    },

    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      if (!/^[0-9a-f]{64}$/.test(paymentHash)) {
        return { paid: false }
      }
      const nwc = await getClient()
      try {
        const tx = await nwc.lookupInvoice({ payment_hash: paymentHash })
        const paid = tx.state === 'settled'
        return {
          paid,
          preimage: paid ? tx.preimage : undefined,
        }
      } catch {
        // NOT_FOUND or other errors — treat as unpaid
        return { paid: false }
      }
    },

    async sendPayment(bolt11: string): Promise<{ preimage: string }> {
      const nwc = await getClient()
      const timeoutMs = timeout ?? 60_000
      const timer = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('NWC sendPayment: timed out')), timeoutMs),
      )
      const result = await Promise.race([nwc.payInvoice(bolt11), timer])
      if (!result.preimage) {
        throw new Error('NWC sendPayment: response missing preimage')
      }
      return { preimage: result.preimage }
    },
  }
}
