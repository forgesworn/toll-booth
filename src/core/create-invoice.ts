// src/core/create-invoice.ts
import QRCode from 'qrcode'
import type { LightningBackend, CreditTier } from '../types.js'
import type { StorageBackend } from '../storage/interface.js'
import { mintMacaroon } from '../macaroon.js'
import type { CreateInvoiceRequest, CreateInvoiceResult } from './types.js'

export interface CreateInvoiceDeps {
  backend: LightningBackend
  storage: StorageBackend
  rootKey: string
  tiers: CreditTier[]
  defaultAmount: number
}

/**
 * Framework-agnostic invoice creation handler.
 *
 * Validates the requested amount against configured tiers (if any),
 * creates a new Lightning invoice, mints a macaroon, stores everything,
 * and returns structured result data.
 */
export async function handleCreateInvoice(
  deps: CreateInvoiceDeps,
  request: CreateInvoiceRequest,
): Promise<CreateInvoiceResult> {
  try {
    const requestedAmount = request.amountSats ?? deps.defaultAmount

    // Find matching tier or validate amount
    let creditSats = requestedAmount
    if (deps.tiers.length > 0) {
      const tier = deps.tiers.find(t => t.amountSats === requestedAmount)
      if (!tier) {
        return {
          success: false,
          error: 'Invalid amount. Choose from available tiers.',
          tiers: deps.tiers,
        }
      }
      creditSats = tier.creditSats
    }

    const invoice = await deps.backend.createInvoice(
      requestedAmount,
      `toll-booth: ${creditSats} sats credit`,
    )
    const macaroon = mintMacaroon(deps.rootKey, invoice.paymentHash, creditSats)

    deps.storage.storeInvoice(invoice.paymentHash, invoice.bolt11, creditSats, macaroon)

    const qrSvg = await QRCode.toString(
      `lightning:${invoice.bolt11}`.toUpperCase(),
      { type: 'svg', margin: 2 },
    )

    return {
      success: true,
      data: {
        bolt11: invoice.bolt11,
        paymentHash: invoice.paymentHash,
        paymentUrl: `/invoice-status/${invoice.paymentHash}`,
        amountSats: requestedAmount,
        creditSats,
        macaroon,
        qrSvg,
      },
    }
  } catch {
    return { success: false, error: 'Failed to create invoice' }
  }
}
