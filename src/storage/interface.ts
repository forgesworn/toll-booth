// src/storage/interface.ts

export interface DebitResult {
  success: boolean
  remaining: number
}

export interface StoredInvoice {
  paymentHash: string
  bolt11: string
  amountSats: number
  macaroon: string
  createdAt: string
}

export interface PendingClaim {
  paymentHash: string
  token: string
  claimedAt: string
}

export interface StorageBackend {
  credit(paymentHash: string, amount: number): void
  debit(paymentHash: string, amount: number): DebitResult
  balance(paymentHash: string): number
  /** Atomically mark a payment hash as settled. Returns true if newly settled, false if already was. */
  settle(paymentHash: string): boolean
  /** Check whether a payment hash has been settled. */
  isSettled(paymentHash: string): boolean
  /** Atomically settle and credit in one operation. Returns true if newly settled, false if already was. */
  settleWithCredit(paymentHash: string, amount: number): boolean
  /**
   * Write-ahead claim with an exclusive lease before an irreversible external call.
   * Returns true if newly claimed, false if already claimed or settled.
   * Sets a lease that expires after `leaseMs` milliseconds (default 30000).
   * The claim persists across restarts for crash recovery.
   */
  claimForRedeem(paymentHash: string, token: string, leaseMs?: number): boolean
  /** Returns all claims that were never settled (for crash recovery on startup). */
  pendingClaims(): PendingClaim[]
  /**
   * Atomically acquire an exclusive recovery lease on an existing pending claim.
   * Only succeeds if the claim exists, is not settled, and the previous lease has expired.
   * Returns the claim if the lease was acquired, undefined otherwise.
   */
  tryAcquireRecoveryLease(paymentHash: string, leaseMs: number): PendingClaim | undefined
  /**
   * Extend an active lease on a pending claim.
   * Returns true if extended, false if missing/settled/expired.
   */
  extendRecoveryLease(paymentHash: string, leaseMs: number): boolean
  storeInvoice(paymentHash: string, bolt11: string, amountSats: number, macaroon: string): void
  getInvoice(paymentHash: string): StoredInvoice | undefined
  close(): void
}
