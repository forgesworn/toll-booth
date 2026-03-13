import { randomBytes } from 'node:crypto'
import type { StorageBackend } from '../storage/interface.js'
import type { CashuRedeemRequest, CashuRedeemResult } from './types.js'
import { PAYMENT_HASH_RE } from './types.js'

export const REDEEM_LEASE_MS = 30_000
const REDEEM_LEASE_RENEW_MS = Math.max(1_000, Math.floor(REDEEM_LEASE_MS / 2))

export interface CashuRedeemDeps {
  redeem: (token: string, paymentHash: string) => Promise<number>
  storage: StorageBackend
}

export async function handleCashuRedeem(
  deps: CashuRedeemDeps,
  request: CashuRedeemRequest,
): Promise<CashuRedeemResult> {
  try {
    const { token, paymentHash, statusToken } = request
    if (
      typeof token !== 'string' || !token || token.length > 16_384 ||
      !PAYMENT_HASH_RE.test(paymentHash) ||
      typeof statusToken !== 'string' || !statusToken || statusToken.length > 128
    ) {
      return { success: false, error: 'Invalid request: token, paymentHash, and statusToken required', status: 400 }
    }

    const invoice = deps.storage.getInvoiceForStatus(paymentHash, statusToken)
    if (!invoice) {
      return { success: false, error: 'Unknown payment hash or invalid status token', status: 400 }
    }

    // Fast path: already settled
    if (deps.storage.isSettled(paymentHash)) {
      return {
        success: true,
        credited: 0,
        tokenSuffix: deps.storage.getSettlementSecret(paymentHash) ?? '',
      }
    }

    // Try to claim exclusively before the irreversible external redeem call.
    if (!deps.storage.claimForRedeem(paymentHash, token, REDEEM_LEASE_MS)) {
      // Already settled — idempotent success
      if (deps.storage.isSettled(paymentHash)) {
        return {
          success: true,
          credited: 0,
          tokenSuffix: deps.storage.getSettlementSecret(paymentHash) ?? '',
        }
      }

      // Retry an expired lease. This is only correct when the redeem
      // implementation is idempotent for the same paymentHash.
      const pendingClaim = deps.storage.tryAcquireRecoveryLease(paymentHash, REDEEM_LEASE_MS)
      if (pendingClaim) {
        try {
          const credited = await withLeaseKeepAlive(deps.storage, paymentHash, () =>
            deps.redeem(pendingClaim.token, paymentHash),
          )
          const settlementSecret = randomBytes(32).toString('hex')
          const newlySettled = deps.storage.settleWithCredit(paymentHash, credited, settlementSecret)
          return {
            success: true,
            credited: newlySettled ? credited : 0,
            tokenSuffix: newlySettled ? settlementSecret : deps.storage.getSettlementSecret(paymentHash) ?? '',
          }
        } catch {
          return { success: false, state: 'pending', retryAfterMs: 2000 }
        }
      }

      return { success: false, state: 'pending', retryAfterMs: 2000 }
    }

    // We hold the exclusive claim — call the external mint
    try {
      const credited = await withLeaseKeepAlive(deps.storage, paymentHash, () =>
        deps.redeem(token, paymentHash),
      )
      const settlementSecret = randomBytes(32).toString('hex')
      const newlySettled = deps.storage.settleWithCredit(paymentHash, credited, settlementSecret)
      return {
        success: true,
        credited: newlySettled ? credited : 0,
        tokenSuffix: newlySettled ? settlementSecret : deps.storage.getSettlementSecret(paymentHash) ?? '',
      }
    } catch {
      return { success: false, state: 'pending', retryAfterMs: 2000 }
    }
  } catch (err) {
    console.error('[toll-booth] Cashu redeem error:', err instanceof Error ? err.constructor.name : 'unknown')
    return { success: false, error: 'Cashu redemption failed', status: 500 }
  }
}

async function withLeaseKeepAlive<T>(
  storage: StorageBackend,
  paymentHash: string,
  fn: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    storage.extendRecoveryLease(paymentHash, REDEEM_LEASE_MS)
  }, REDEEM_LEASE_RENEW_MS)

  try {
    return await fn()
  } finally {
    clearInterval(timer)
  }
}
