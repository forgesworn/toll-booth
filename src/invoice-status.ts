import type { Context } from 'hono'
import type { LightningBackend, CreditTier } from './types.js'
import type { InvoiceStore } from './invoice-store.js'
import type { CreditMeter } from './meter.js'
import { renderPaymentPage, renderErrorPage } from './payment-page.js'

export interface InvoiceStatusDeps {
  backend: LightningBackend
  invoiceStore?: InvoiceStore
  meter?: CreditMeter
  tiers?: CreditTier[]
  nwcEnabled?: boolean
  cashuEnabled?: boolean
}

/**
 * Creates a Hono route handler that checks invoice payment status.
 * Mount as: app.get('/invoice-status/:paymentHash', invoiceStatus(deps))
 *
 * Content negotiation:
 * - Accept: text/html → renders HTML payment page
 * - Accept: application/json (or default) → returns JSON as before
 */
export function invoiceStatus(depsOrBackend: InvoiceStatusDeps | LightningBackend) {
  // Backwards-compatible: accept a bare LightningBackend
  const deps: InvoiceStatusDeps = 'checkInvoice' in depsOrBackend
    ? { backend: depsOrBackend }
    : depsOrBackend

  return async (c: Context) => {
    const hash = c.req.param('paymentHash')
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
      return c.json({ error: 'Invalid payment hash — expected 64 hex characters' }, 400)
    }
    const acceptsHtml = c.req.header('Accept')?.includes('text/html')

    try {
      // If requesting HTML, check if we have stored invoice details
      if (acceptsHtml && deps.invoiceStore) {
        const stored = deps.invoiceStore.get(hash)
        if (!stored) {
          return c.html(renderErrorPage({
            paymentHash: hash,
            message: 'This invoice was not found. It may have expired or the payment hash is incorrect.',
          }), 404)
        }

        const status = await deps.backend.checkInvoice(hash)
        const html = await renderPaymentPage({
          invoice: stored,
          paid: status.paid,
          preimage: status.preimage,
          tiers: deps.tiers ?? [],
          nwcEnabled: deps.nwcEnabled ?? false,
          cashuEnabled: deps.cashuEnabled ?? false,
        })
        return c.html(html)
      }

      // JSON response (default, or when no invoice store)
      const status = await deps.backend.checkInvoice(hash)
      return c.json(status)
    } catch {
      if (acceptsHtml && deps.invoiceStore) {
        return c.html(renderErrorPage({
          paymentHash: hash,
          message: 'Failed to check invoice status. Please try again.',
        }), 502)
      }
      return c.json({ error: 'Failed to check invoice status' }, 502)
    }
  }
}
