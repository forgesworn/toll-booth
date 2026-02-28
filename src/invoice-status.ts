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
    const status = await backend.checkInvoice(hash)
    return c.json(status)
  }
}
