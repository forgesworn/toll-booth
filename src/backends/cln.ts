import { randomBytes } from 'node:crypto'
import type { LightningBackend, Invoice, InvoiceStatus } from '../types.js'
import { PAYMENT_HASH_RE } from '../core/types.js'

export interface ClnConfig {
  /** CLN REST API URL (e.g. https://localhost:3010). */
  url: string
  /** Rune token for authentication. */
  rune: string
  /** Request timeout in ms (default: 30000) */
  timeout?: number
}

/**
 * Lightning backend adapter for Core Lightning's REST API (clnrest).
 *
 * Uses the `/v1/invoice` and `/v1/listinvoices` endpoints.
 * Authentication via `Rune` header.
 *
 * CLN requires a unique `label` per invoice — we generate one using
 * a `toll-booth-` prefix and a timestamp + random suffix.
 *
 * @see https://docs.corelightning.org/docs/rest
 */
export function clnBackend(config: ClnConfig): LightningBackend {
  const baseUrl = config.url.replace(/\/$/, '')
  const timeoutMs = config.timeout ?? 30_000
  const headers: Record<string, string> = {
    'Rune': config.rune,
  }

  return {
    async createInvoice(amountSats: number, memo?: string): Promise<Invoice> {
      const label = `toll-booth-${Date.now()}-${randomBytes(6).toString('hex')}`

      const res = await fetch(`${baseUrl}/v1/invoice`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount_msat: amountSats * 1000,
          label,
          description: memo ?? 'toll-booth payment',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`CLN createInvoice failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const data = await res.json() as { bolt11: string; payment_hash: string }
      return { bolt11: data.bolt11, paymentHash: data.payment_hash }
    },

    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      if (!PAYMENT_HASH_RE.test(paymentHash)) throw new Error('Invalid payment hash')
      const res = await fetch(
        `${baseUrl}/v1/listinvoices?payment_hash=${paymentHash}`,
        { headers, signal: AbortSignal.timeout(timeoutMs) },
      )

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`CLN checkInvoice failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const data = await res.json() as {
        invoices: Array<{
          status: string
          payment_preimage?: string
        }>
      }

      const inv = data.invoices[0]
      if (!inv || inv.status !== 'paid') return { paid: false }

      return {
        paid: true,
        preimage: inv.payment_preimage,
      }
    },

    async sendPayment(bolt11: string): Promise<{ preimage: string }> {
      const res = await fetch(`${baseUrl}/v1/pay`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bolt11 }),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`CLN sendPayment failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const data = await res.json() as { payment_preimage: string }
      return { preimage: data.payment_preimage }
    },
  }
}
