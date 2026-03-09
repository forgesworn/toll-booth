// src/create-invoice.ts
import type { Context } from 'hono'
import QRCode from 'qrcode'
import type { LightningBackend, CreditTier } from './types.js'
import type { InvoiceStore } from './invoice-store.js'
import { mintMacaroon } from './macaroon.js'

export interface CreateInvoiceDeps {
  backend: LightningBackend
  invoiceStore: InvoiceStore
  rootKey: string
  tiers: CreditTier[]
  defaultAmount: number
}

/**
 * Creates a Hono route handler for `POST /create-invoice`.
 *
 * Validates the requested amount against configured tiers (if any),
 * creates a new Lightning invoice, mints a macaroon, stores everything,
 * and returns the invoice details.
 */
export function createInvoiceHandler(deps: CreateInvoiceDeps) {
  return async (c: Context) => {
    try {
      const body = await c.req.json<{ amountSats?: number }>()
      const requestedAmount = body.amountSats ?? deps.defaultAmount

      if (!Number.isInteger(requestedAmount) || requestedAmount < 1) {
        return c.json({ error: 'amountSats must be a positive integer' }, 400)
      }

      // Find matching tier or validate amount
      let creditSats = requestedAmount
      if (deps.tiers.length > 0) {
        const tier = deps.tiers.find(t => t.amountSats === requestedAmount)
        if (!tier) {
          return c.json({
            error: 'Invalid amount. Choose from available tiers.',
            tiers: deps.tiers.map(t => ({
              amountSats: t.amountSats,
              creditSats: t.creditSats,
              label: t.label,
            })),
          }, 400)
        }
        creditSats = tier.creditSats
      }

      const invoice = await deps.backend.createInvoice(
        requestedAmount,
        `toll-booth: ${creditSats} sats credit`,
      )
      const macaroon = mintMacaroon(deps.rootKey, invoice.paymentHash, creditSats)

      deps.invoiceStore.store(invoice.paymentHash, invoice.bolt11, creditSats, macaroon)

      const qrSvg = await QRCode.toString(`lightning:${invoice.bolt11}`.toUpperCase(), { type: 'svg', margin: 2 })

      return c.json({
        bolt11: invoice.bolt11,
        payment_hash: invoice.paymentHash,
        payment_url: `/invoice-status/${invoice.paymentHash}`,
        amount_sats: requestedAmount,
        credit_sats: creditSats,
        macaroon,
        qr_svg: qrSvg,
      })
    } catch {
      return c.json({ error: 'Failed to create invoice' }, 500)
    }
  }
}
