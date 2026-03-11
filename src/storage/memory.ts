// src/storage/memory.ts
import type { StorageBackend, DebitResult, StoredInvoice, PendingClaim } from './interface.js'

const DEFAULT_LEASE_MS = 30_000

export function memoryStorage(): StorageBackend {
  const balances = new Map<string, number>()
  const invoices = new Map<string, StoredInvoice>()
  const settled = new Set<string>()
  const claims = new Map<string, { token: string; claimedAt: string; leaseExpiresAt: number }>()

  return {
    credit(paymentHash: string, amount: number): void {
      const current = balances.get(paymentHash) ?? 0
      balances.set(paymentHash, current + amount)
    },

    debit(paymentHash: string, amount: number): DebitResult {
      const current = balances.get(paymentHash) ?? 0
      if (current < amount) {
        return { success: false, remaining: current }
      }
      const remaining = current - amount
      balances.set(paymentHash, remaining)
      return { success: true, remaining }
    },

    balance(paymentHash: string): number {
      return balances.get(paymentHash) ?? 0
    },

    settle(paymentHash: string): boolean {
      if (settled.has(paymentHash)) return false
      settled.add(paymentHash)
      return true
    },

    isSettled(paymentHash: string): boolean {
      return settled.has(paymentHash)
    },

    settleWithCredit(paymentHash: string, amount: number): boolean {
      if (settled.has(paymentHash)) return false
      settled.add(paymentHash)
      claims.delete(paymentHash)
      const current = balances.get(paymentHash) ?? 0
      balances.set(paymentHash, current + amount)
      return true
    },

    claimForRedeem(paymentHash: string, token: string, leaseMs?: number): boolean {
      if (settled.has(paymentHash) || claims.has(paymentHash)) return false
      claims.set(paymentHash, {
        token,
        claimedAt: new Date().toISOString(),
        leaseExpiresAt: Date.now() + (leaseMs ?? DEFAULT_LEASE_MS),
      })
      return true
    },

    pendingClaims(): PendingClaim[] {
      return Array.from(claims.entries())
        .filter(([paymentHash]) => !settled.has(paymentHash))
        .map(([paymentHash, { token, claimedAt }]) => ({
          paymentHash, token, claimedAt,
        }))
    },

    tryAcquireRecoveryLease(paymentHash: string, leaseMs: number): PendingClaim | undefined {
      if (settled.has(paymentHash)) return undefined
      const claim = claims.get(paymentHash)
      if (!claim) return undefined
      if (Date.now() < claim.leaseExpiresAt) return undefined
      // Lease expired — acquire it
      claim.leaseExpiresAt = Date.now() + leaseMs
      return { paymentHash, token: claim.token, claimedAt: claim.claimedAt }
    },

    extendRecoveryLease(paymentHash: string, leaseMs: number): boolean {
      if (settled.has(paymentHash)) return false
      const claim = claims.get(paymentHash)
      if (!claim) return false
      if (Date.now() >= claim.leaseExpiresAt) return false
      claim.leaseExpiresAt = Date.now() + leaseMs
      return true
    },

    storeInvoice(paymentHash: string, bolt11: string, amountSats: number, macaroon: string): void {
      if (invoices.has(paymentHash)) return
      invoices.set(paymentHash, {
        paymentHash,
        bolt11,
        amountSats,
        macaroon,
        createdAt: new Date().toISOString(),
      })
    },

    getInvoice(paymentHash: string): StoredInvoice | undefined {
      return invoices.get(paymentHash)
    },

    close(): void {
      balances.clear()
      invoices.clear()
      settled.clear()
      claims.clear()
    },
  }
}
