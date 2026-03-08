// src/core/invoice-status.ts
import type { LightningBackend, CreditTier } from '../types.js'
import type { StorageBackend } from '../storage/interface.js'
import { renderPaymentPage, renderErrorPage } from '../payment-page.js'
import type { InvoiceStatusResult } from './types.js'

export interface InvoiceStatusDeps {
  backend: LightningBackend
  storage: StorageBackend
  tiers?: CreditTier[]
  nwcEnabled?: boolean
  cashuEnabled?: boolean
}

/**
 * Framework-agnostic invoice status check.
 * Returns structured data suitable for JSON responses.
 */
export async function handleInvoiceStatus(
  deps: InvoiceStatusDeps,
  paymentHash: string,
): Promise<InvoiceStatusResult> {
  const invoice = deps.storage.getInvoice(paymentHash)
  if (!invoice) {
    return { found: false, paid: false }
  }

  const status = await deps.backend.checkInvoice(paymentHash)
  return {
    found: true,
    paid: status.paid,
    preimage: status.preimage,
    invoice,
  }
}

/**
 * Framework-agnostic invoice status rendered as HTML.
 * Returns the HTML string and appropriate HTTP status code.
 */
export async function renderInvoiceStatusHtml(
  deps: InvoiceStatusDeps,
  paymentHash: string,
): Promise<{ html: string; status: number }> {
  try {
    const invoice = deps.storage.getInvoice(paymentHash)
    if (!invoice) {
      return {
        html: renderErrorPage({
          paymentHash,
          message: 'This invoice was not found. It may have expired or the payment hash is incorrect.',
        }),
        status: 404,
      }
    }

    const status = await deps.backend.checkInvoice(paymentHash)
    const html = await renderPaymentPage({
      invoice,
      paid: status.paid,
      preimage: status.preimage,
      tiers: deps.tiers ?? [],
      nwcEnabled: deps.nwcEnabled ?? false,
      cashuEnabled: deps.cashuEnabled ?? false,
    })
    return { html, status: 200 }
  } catch {
    return {
      html: renderErrorPage({
        paymentHash,
        message: 'Failed to check invoice status. Please try again.',
      }),
      status: 502,
    }
  }
}
