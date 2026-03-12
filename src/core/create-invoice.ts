// src/core/create-invoice.ts
import { randomBytes } from 'node:crypto'
import QRCode from 'qrcode'
import type { LightningBackend, CreditTier } from '../types.js'
import type { StorageBackend } from '../storage/interface.js'
import { mintMacaroon } from '../macaroon.js'
import type { CreateInvoiceRequest, CreateInvoiceResult } from './types.js'

export interface CreateInvoiceDeps {
  backend?: LightningBackend
  storage: StorageBackend
  rootKey: string
  tiers: CreditTier[]
  defaultAmount: number
  maxPendingPerIp?: number
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
    if (deps.maxPendingPerIp && request.clientIp) {
      const pending = deps.storage.pendingInvoiceCount(request.clientIp)
      if (pending >= deps.maxPendingPerIp) {
        return { success: false, error: 'Invoice creation rate limit exceeded', status: 429 }
      }
    }

    const requestedAmount = request.amountSats ?? deps.defaultAmount

    if (!Number.isSafeInteger(requestedAmount) || requestedAmount < 1 || requestedAmount > 2_100_000_000_000_000) {
      return { success: false, error: 'amountSats must be a positive integer' }
    }

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

    let paymentHash: string
    let bolt11: string | undefined

    if (deps.backend) {
      const invoice = await deps.backend.createInvoice(
        requestedAmount,
        `toll-booth: ${creditSats} sats credit`,
      )
      paymentHash = invoice.paymentHash
      bolt11 = invoice.bolt11
    } else {
      // Cashu-only mode: synthetic payment hash
      paymentHash = randomBytes(32).toString('hex')
    }

    const macaroon = mintMacaroon(deps.rootKey, paymentHash, creditSats, request.caveats)
    const statusToken = randomBytes(32).toString('hex')

    deps.storage.storeInvoice(paymentHash, bolt11 ?? '', creditSats, macaroon, statusToken, request.clientIp)

    const qrSvg = bolt11
      ? await QRCode.toString(
          `lightning:${bolt11}`.toUpperCase(),
          { type: 'svg', margin: 2 },
        )
      : undefined

    return {
      success: true,
      data: {
        bolt11: bolt11 ?? '',
        paymentHash,
        paymentUrl: `/invoice-status/${paymentHash}?token=${statusToken}`,
        amountSats: requestedAmount,
        creditSats,
        macaroon,
        qrSvg: qrSvg ?? '',
      },
    }
  } catch (err) {
    console.error('[toll-booth] create invoice error:', err instanceof Error ? err.message : err)
    return { success: false, error: 'Failed to create invoice' }
  }
}
