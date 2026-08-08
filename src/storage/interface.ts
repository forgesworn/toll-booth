// src/storage/interface.ts
import type { Currency } from '../core/payment-rail.js'

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

export interface Session {
  sessionId: string
  paymentHash: string
  balanceSats: number
  depositSats: number
  returnInvoice: string | null
  bearerToken: string
  createdAt: string
  expiresAt: string
  closedAt: string | null
  refundPreimage: string | null
}

export interface StorageBackend {
  credit(paymentHash: string, amount: number, currency?: Currency): void
  debit(paymentHash: string, amount: number, currency?: Currency): DebitResult
  balance(paymentHash: string, currency?: Currency): number
  /** Adjust credits by delta. Positive = refund, negative = additional charge. Clamps to zero. Returns new balance. */
  adjustCredits(paymentHash: string, delta: number, currency?: Currency): number
  /** Atomically mark a payment hash as settled. Returns true if newly settled, false if already was. */
  settle(paymentHash: string): boolean
  /** Check whether a payment hash has been settled. */
  isSettled(paymentHash: string): boolean
  /** Atomically settle and credit in one operation. Returns true if newly settled, false if already was. */
  settleWithCredit(paymentHash: string, amount: number, settlementSecret?: string, currency?: Currency): boolean
  /** Optional secret required for non-preimage L402 authorisation after settlement (e.g. Cashu flow). */
  getSettlementSecret(paymentHash: string): string | undefined
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
  storeInvoice(paymentHash: string, bolt11: string, amountSats: number, macaroon: string, statusToken: string, clientIp?: string): void
  /** Count pending (unpaid) invoices for a given client IP hash. */
  pendingInvoiceCount(clientIp: string): number
  getInvoice(paymentHash: string): StoredInvoice | undefined
  getInvoiceForStatus(paymentHash: string, statusToken: string): StoredInvoice | undefined
  /** Delete invoices older than maxAgeMs. Returns the number of deleted rows. */
  pruneExpiredInvoices(maxAgeMs: number): number
  /** Delete zero-balance credits and aged settlements/claims. Returns total deleted rows. */
  pruneStaleRecords(maxAgeMs: number): number
  createSession(session: { sessionId: string, paymentHash: string, balanceSats: number, depositSats: number, bearerToken: string, expiresAt: string, returnInvoice?: string }): void
  /**
   * Atomically create a session and mark its deposit payment hash as settled.
   * Returns false (and writes nothing) if the session already exists or the
   * payment hash was already settled — this prevents a deposit preimage from
   * being replayed as a top-up after the session is open.
   */
  createSessionWithSettlement(session: { sessionId: string, paymentHash: string, balanceSats: number, depositSats: number, bearerToken: string, expiresAt: string, returnInvoice?: string }): boolean
  getSession(sessionId: string): Session | null
  getSessionByBearer(bearerToken: string): Session | null
  deductSession(sessionId: string, amount: number): { newBalance: number }
  topUpSession(sessionId: string, amount: number): { newBalance: number }
  /**
   * Atomically mark a top-up payment hash as settled and credit the session.
   * Returns the new balance, or null if the payment hash was already settled
   * (replay). Throws if the session is missing or closed. The settlement
   * marker and balance update commit or roll back together.
   */
  topUpSessionWithSettlement(sessionId: string, amount: number, paymentHash: string): { newBalance: number } | null
  closeSession(sessionId: string, refundPreimage?: string): void
  getExpiredSessions(): Session[]
  pruneClosedSessions(maxAgeMs: number): number
  close(): void
}
