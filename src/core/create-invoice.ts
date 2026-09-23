// src/core/create-invoice.ts
import { randomBytes } from 'node:crypto'
import QRCode from 'qrcode'
import type { LightningBackend, CreditTier } from '../types.js'
import type { StorageBackend } from '../storage/interface.js'
import { mintMacaroon } from '../macaroon.js'
import { deriveIpHashKey, hashIp } from './types.js'
import type { CreateInvoiceRequest, CreateInvoiceResult } from './types.js'

/** Caveat keys that control monetary value and must not be set by clients. */
const RESERVED_CAVEAT_KEYS = new Set(['payment_hash', 'credit_balance'])

export interface CreateInvoiceDeps {
  backend?: LightningBackend
  storage: StorageBackend
  rootKey: string
  tiers: CreditTier[]
  defaultAmount: number
  maxPendingPerIp?: number
  /** Human-readable service name for invoice descriptions. Defaults to 'toll-booth'. */
  serviceName?: string
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
    const ipHash = request.clientIp ? hashIp(request.clientIp, deriveIpHashKey(deps.rootKey)) : undefined
    if (deps.maxPendingPerIp && ipHash) {
      const pending = deps.storage.pendingInvoiceCount(ipHash)
      if (pending >= deps.maxPendingPerIp) {
        return { success: false, error: 'Invoice creation rate limit exceeded', status: 429 }
      }
    }

    // Validate caveats input type and reject built-in caveat keys
    if (request.caveats !== undefined) {
      if (!Array.isArray(request.caveats)) {
        return { success: false, error: 'caveats must be an array of strings' }
      }
      for (const c of request.caveats) {
        if (typeof c !== 'string') {
          return { success: false, error: 'caveats must be an array of strings' }
        }
        const eqIdx = c.indexOf(' = ')
        if (eqIdx !== -1) {
          const key = c.slice(0, eqIdx).trim()
          if (RESERVED_CAVEAT_KEYS.has(key)) {
            return { success: false, error: `caveat key "${key}" is reserved and cannot be set by clients` }
          }
        }
      }
    }

    const requestedAmount = request.amountSats ?? deps.defaultAmount

    if (!Number.isSafeInteger(requestedAmount) || requestedAmount < 1 || requestedAmount > 2_100_000_000_000_000) {
      return { success: false, error: 'amountSats must be a positive integer' }
    }

    // Find matching tier for bonus credits, or accept custom amount at 1:1
    let creditSats = requestedAmount
    if (deps.tiers.length > 0) {
      const tier = deps.tiers.find(t => t.amountSats === requestedAmount)
      if (tier) {
        creditSats = tier.creditSats
      }
      // Custom amounts are accepted at 1:1 (no bonus) — no rejection
    }

    let paymentHash: string
    let bolt11: string | undefined

    if (deps.backend) {
      const label = deps.serviceName ?? 'toll-booth'
      const invoice = await deps.backend.createInvoice(
        requestedAmount,
        `${label}: ${creditSats} sats credit`,
      )
      paymentHash = invoice.paymentHash
      bolt11 = invoice.bolt11
    } else {
      // Cashu-only mode: synthetic payment hash
      paymentHash = randomBytes(32).toString('hex')
    }

    const macaroon = mintMacaroon(deps.rootKey, paymentHash, creditSats, request.caveats)
    const statusToken = randomBytes(32).toString('hex')

    deps.storage.storeInvoice(paymentHash, bolt11 ?? '', creditSats, macaroon, statusToken, ipHash)

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
