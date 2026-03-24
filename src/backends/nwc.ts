import type { LightningBackend, Invoice, InvoiceStatus } from '../types.js'

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
 * The `nostr-core` package is imported dynamically so it only needs
 * to be installed when this backend is actually used.
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
  let clientPromise: Promise<InstanceType<typeof import('nostr-core').NWC>> | undefined

  async function getClient() {
    if (!clientPromise) {
      clientPromise = (async () => {
        const { NWC } = await import('nostr-core')
        const nwc = new NWC(nwcUrl)
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
