// src/core/invoice-status.ts
import type { LightningBackend, CreditTier } from '../types.js'
import type { StorageBackend } from '../storage/interface.js'
import { renderPaymentPage, renderErrorPage } from '../payment-page.js'
import type { InvoiceStatusResult } from './types.js'

export interface InvoiceStatusDeps {
  backend?: LightningBackend
  storage: StorageBackend
  tiers?: CreditTier[]
  cashuEnabled?: boolean
}

/**
 * Framework-agnostic invoice status check.
 * Returns structured data suitable for JSON responses.
 */
export async function handleInvoiceStatus(
  deps: InvoiceStatusDeps,
  paymentHash: string,
  statusToken?: string,
): Promise<InvoiceStatusResult> {
  const invoice = statusToken
    ? deps.storage.getInvoiceForStatus(paymentHash, statusToken)
    : undefined
  if (!invoice) {
    return { found: false, paid: false }
  }

  // In Cashu-only mode (no backend), check settlement status from storage
  if (!deps.backend) {
    const settled = deps.storage.isSettled(paymentHash)
    return {
      found: true,
      paid: settled,
      tokenSuffix: settled ? deps.storage.getSettlementSecret(paymentHash) : undefined,
      invoice,
    }
  }

  try {
    const status = await deps.backend.checkInvoice(paymentHash)
    return {
      found: true,
      paid: status.paid,
      preimage: status.preimage,
      tokenSuffix: status.preimage ?? (status.paid ? deps.storage.getSettlementSecret(paymentHash) : undefined),
      invoice,
    }
  } catch {
    // Backend temporarily unreachable; report as unpaid so the client keeps polling
    return { found: true, paid: false, invoice }
  }
}

/**
 * Framework-agnostic invoice status rendered as HTML.
 * Returns the HTML string and appropriate HTTP status code.
 */
export async function renderInvoiceStatusHtml(
  deps: InvoiceStatusDeps,
  paymentHash: string,
  statusToken?: string,
): Promise<{ html: string; status: number }> {
  try {
    const invoice = statusToken
      ? deps.storage.getInvoiceForStatus(paymentHash, statusToken)
      : undefined
    if (!invoice) {
      return {
        html: renderErrorPage({
          paymentHash,
          message: 'This invoice was not found. It may have expired or the payment hash is incorrect.',
        }),
        status: 404,
      }
    }

    let status: { paid: boolean; preimage?: string }
    try {
      status = deps.backend
        ? await deps.backend.checkInvoice(paymentHash)
        : { paid: deps.storage.isSettled(paymentHash), preimage: undefined }
    } catch {
      // Backend temporarily unreachable; render as unpaid so the client keeps polling
      status = { paid: false, preimage: undefined }
    }
    const html = await renderPaymentPage({
      invoice,
      paid: status.paid,
      preimage: status.preimage,
      tokenSuffix: status.preimage ?? (status.paid ? deps.storage.getSettlementSecret(paymentHash) : undefined),
      tiers: deps.tiers ?? [],
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
