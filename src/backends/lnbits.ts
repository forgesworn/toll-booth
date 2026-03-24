import type { LightningBackend, Invoice, InvoiceStatus } from '../types.js'
import { PAYMENT_HASH_RE } from '../core/types.js'

export interface LNbitsConfig {
  /** LNbits instance URL (e.g. https://legend.lnbits.com) */
  url: string
  /** Invoice/read API key from the LNbits wallet */
  apiKey: string
  /** Request timeout in ms (default: 30000) */
  timeout?: number
}

/**
 * Lightning backend adapter for LNbits.
 *
 * Uses the LNbits Payments API with `X-Api-Key` header authentication.
 * Works with any LNbits instance — self-hosted or hosted (legend.lnbits.com).
 *
 * LNbits abstracts over multiple funding sources (LND, CLN, Phoenixd,
 * LndHub, etc.), so this backend supports any node type that LNbits
 * connects to.
 *
 * @see https://lnbits.com/
 */
export function lnbitsBackend(config: LNbitsConfig): LightningBackend {
  const baseUrl = config.url.replace(/\/$/, '')
  const timeoutMs = config.timeout ?? 30_000
  const headers: Record<string, string> = {
    'X-Api-Key': config.apiKey,
    'Content-Type': 'application/json',
  }

  return {
    async createInvoice(amountSats: number, memo?: string): Promise<Invoice> {
      const res = await fetch(`${baseUrl}/api/v1/payments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          out: false,
          amount: amountSats,
          memo: memo ?? 'toll-booth payment',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`LNbits createInvoice failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const data = await res.json() as { payment_hash: string; payment_request: string }
      return { bolt11: data.payment_request, paymentHash: data.payment_hash }
    },

    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      if (!PAYMENT_HASH_RE.test(paymentHash)) throw new Error('Invalid payment hash')
      const res = await fetch(`${baseUrl}/api/v1/payments/${paymentHash}`, {
        headers: { 'X-Api-Key': config.apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (res.status === 404) return { paid: false }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`LNbits checkInvoice failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const data = await res.json() as { paid: boolean; preimage?: string }
      return {
        paid: data.paid,
        preimage: data.paid ? data.preimage : undefined,
      }
    },

    async sendPayment(bolt11: string): Promise<{ preimage: string }> {
      const res = await fetch(`${baseUrl}/api/v1/payments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ out: true, bolt11 }),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`LNbits sendPayment failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const payData = await res.json() as { checking_id: string; payment_hash: string }

      // Look up the completed payment to retrieve the preimage
      const detailRes = await fetch(`${baseUrl}/api/v1/payments/${payData.checking_id}`, {
        headers: { 'X-Api-Key': config.apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!detailRes.ok) {
        const text = await detailRes.text().catch(() => '')
        throw new Error(`LNbits sendPayment detail lookup failed (${detailRes.status}): ${text.slice(0, 200)}`)
      }

      const detail = await detailRes.json() as { details: { preimage: string } }
      return { preimage: detail.details.preimage }
    },
  }
}
