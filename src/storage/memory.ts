// src/storage/memory.ts
import type { StorageBackend, DebitResult, StoredInvoice, PendingClaim } from './interface.js'

export function memoryStorage(): StorageBackend {
  const balances = new Map<string, number>()
  const invoices = new Map<string, StoredInvoice>()
  const settled = new Set<string>()
  const claims = new Map<string, { token: string; claimedAt: string }>()

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

    claimForRedeem(paymentHash: string, token: string): boolean {
      if (settled.has(paymentHash) || claims.has(paymentHash)) return false
      claims.set(paymentHash, { token, claimedAt: new Date().toISOString() })
      return true
    },

    pendingClaims(): PendingClaim[] {
      return Array.from(claims.entries()).map(([paymentHash, { token, claimedAt }]) => ({
        paymentHash, token, claimedAt,
      }))
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
