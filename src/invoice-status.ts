import type { Context } from 'hono'
import type { LightningBackend } from './types.js'

/**
 * Creates a Hono route handler that checks invoice payment status.
 * Mount as: app.get('/invoice-status/:paymentHash', invoiceStatus(backend))
 *
 * Returns { paid: false } or { paid: true, preimage: '...' }.
 */
export function invoiceStatus(backend: LightningBackend) {
  return async (c: Context) => {
    const hash = c.req.param('paymentHash')
    try {
      const status = await backend.checkInvoice(hash)
      return c.json(status)
    } catch {
      return c.json({ error: 'Failed to check invoice status' }, 502)
    }
  }
}
