import type { LightningBackend, Invoice, InvoiceStatus } from '../types.js'
import { PAYMENT_HASH_RE } from '../core/types.js'

export interface PhoenixdConfig {
  url: string
  password: string
  /** Request timeout in ms (default: 30000) */
  timeout?: number
}

/**
 * Lightning backend adapter for Phoenixd's HTTP API.
 *
 * Phoenixd uses HTTP Basic auth with an empty username — the Authorization
 * header encodes `:password` (note the leading colon) in base64.
 * The createinvoice endpoint expects an `application/x-www-form-urlencoded`
 * POST body, not JSON.
 *
 * @see https://phoenix.acinq.co/server/api
 */
export function phoenixdBackend(config: PhoenixdConfig): LightningBackend {
  const baseUrl = config.url.replace(/\/$/, '')
  const authHeader = 'Basic ' + Buffer.from(`:${config.password}`).toString('base64')
  const timeoutMs = config.timeout ?? 30_000

  return {
    async createInvoice(amountSats: number, memo?: string): Promise<Invoice> {
      const body = new URLSearchParams()
      body.set('amountSat', String(amountSats))
      if (memo) body.set('description', memo)
      body.set('externalId', '')

      const res = await fetch(`${baseUrl}/createinvoice`, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Phoenixd createinvoice failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const data = await res.json() as { paymentHash: string; serialized: string }
      return { bolt11: data.serialized, paymentHash: data.paymentHash }
    },

    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      if (!PAYMENT_HASH_RE.test(paymentHash)) throw new Error('Invalid payment hash')
      const res = await fetch(`${baseUrl}/payments/incoming/${paymentHash}`, {
        headers: { 'Authorization': authHeader },
        signal: AbortSignal.timeout(timeoutMs),
      })

      // 404 = invoice not found (normal for unknown hashes)
      if (res.status === 404) return { paid: false }

      // Auth failures and server errors must propagate so health checks detect them
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Phoenixd checkInvoice failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const data = await res.json() as { isPaid: boolean; preimage?: string }
      return {
        paid: data.isPaid,
        preimage: data.isPaid ? data.preimage : undefined,
      }
    },

    async sendPayment(bolt11: string): Promise<{ preimage: string }> {
      const body = new URLSearchParams()
      body.set('invoice', bolt11)

      const res = await fetch(`${baseUrl}/payinvoice`, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Phoenixd payinvoice failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const data = await res.json() as { paymentPreimage: string }
      return { preimage: data.paymentPreimage }
    },
  }
}
