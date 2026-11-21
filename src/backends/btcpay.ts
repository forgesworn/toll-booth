import type { LightningBackend, Invoice, InvoiceStatus } from '../types.js'
import { PAYMENT_HASH_RE } from '../core/types.js'

export interface BTCPayConfig {
  /** BTCPay Server URL (e.g. https://btcpay.example.com) */
  url: string
  /** ID of the store whose Lightning node receives payments */
  storeId: string
  /**
   * Greenfield API key for the store. Needs `btcpay.store.cancreatelightninginvoice`
   * and `btcpay.store.canviewlightninginvoice`; `sendPayment` additionally needs
   * `btcpay.store.canuselightningnode`.
   */
  apiKey: string
  /** Invoice expiry in seconds (default: 3600) */
  expirySecs?: number
  /** Request timeout in ms (default: 30000) */
  timeout?: number
}

/**
 * Lightning backend adapter for BTCPay Server.
 *
 * Uses the store Lightning endpoints of the Greenfield API
 * (`/api/v1/stores/{storeId}/lightning/BTC/...`) with `token` authentication.
 * These talk to whichever Lightning node the store is connected to, so this
 * backend supports any node BTCPay supports, including its internal node.
 *
 * Store invoices (`/api/v1/stores/{storeId}/invoices`) are not used: they are
 * looked up by BTCPay's own invoice ID and never expose the preimage, which
 * toll-booth needs for the payment page.
 *
 * @see https://docs.btcpayserver.org/API/Greenfield/v1/#tag/Lightning-(Store)
 */
export function btcpayBackend(config: BTCPayConfig): LightningBackend {
  const baseUrl = `${config.url.replace(/\/$/, '')}/api/v1/stores/${encodeURIComponent(config.storeId)}/lightning/BTC`
  const timeoutMs = config.timeout ?? 30_000
  const expirySecs = config.expirySecs ?? 3600
  const authHeader = `token ${config.apiKey}`
  const headers: Record<string, string> = {
    'Authorization': authHeader,
    'Content-Type': 'application/json',
  }

  return {
    async createInvoice(amountSats: number, memo?: string): Promise<Invoice> {
      const res = await fetch(`${baseUrl}/invoices`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          // Greenfield amounts are millisatoshis as a decimal string
          amount: String(amountSats * 1000),
          description: memo ?? 'toll-booth payment',
          expiry: expirySecs,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`BTCPay createInvoice failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const data = await res.json() as { BOLT11: string; paymentHash?: string }
      if (!data.paymentHash || !PAYMENT_HASH_RE.test(data.paymentHash)) {
        throw new Error('BTCPay createInvoice returned no valid payment hash')
      }
      return { bolt11: data.BOLT11, paymentHash: data.paymentHash }
    },

    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      if (!PAYMENT_HASH_RE.test(paymentHash)) throw new Error('Invalid payment hash')
      const res = await fetch(`${baseUrl}/invoices/${paymentHash}`, {
        headers: { 'Authorization': authHeader },
        signal: AbortSignal.timeout(timeoutMs),
      })

      // BTCPay also answers 404 when the store has no Lightning node
      // (`lightning-not-configured`); only an unknown invoice means unpaid.
      const text = res.ok ? '' : await res.text().catch(() => '')
      if (res.status === 404 && text.includes('invoice-not-found')) return { paid: false }

      if (!res.ok) {
        throw new Error(`BTCPay checkInvoice failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const data = await res.json() as { status: 'Unpaid' | 'Paid' | 'Expired'; preimage?: string }
      const paid = data.status === 'Paid'
      return {
        paid,
        preimage: paid ? data.preimage : undefined,
      }
    },

    async sendPayment(bolt11: string): Promise<{ preimage: string }> {
      const res = await fetch(`${baseUrl}/invoices/pay`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ BOLT11: bolt11 }),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`BTCPay sendPayment failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const data = await res.json() as { status: string; preimage?: string }
      if (data.status !== 'Complete' || !data.preimage) {
        throw new Error(`BTCPay sendPayment did not complete (status: ${data.status})`)
      }
      return { preimage: data.preimage }
    },
  }
}
