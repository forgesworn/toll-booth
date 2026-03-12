// src/storage/memory.ts
import { timingSafeEqual } from 'node:crypto'
import type { StorageBackend, DebitResult, StoredInvoice, PendingClaim } from './interface.js'

const DEFAULT_LEASE_MS = 30_000
type StoredInvoiceRecord = StoredInvoice & { statusToken: string }

function toStoredInvoice(record: StoredInvoiceRecord): StoredInvoice {
  return {
    paymentHash: record.paymentHash,
    bolt11: record.bolt11,
    amountSats: record.amountSats,
    macaroon: record.macaroon,
    createdAt: record.createdAt,
  }
}

export function memoryStorage(): StorageBackend {
  const balances = new Map<string, number>()
  const invoices = new Map<string, StoredInvoiceRecord>()
  const invoiceIps = new Map<string, string>()
  const settled = new Map<string, string | undefined>()
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

    adjustCredits(paymentHash: string, delta: number): number {
      const current = balances.get(paymentHash) ?? 0
      const newBalance = Math.max(0, current + delta)
      balances.set(paymentHash, newBalance)
      return newBalance
    },

    settle(paymentHash: string): boolean {
      if (settled.has(paymentHash)) return false
      settled.set(paymentHash, undefined)
      return true
    },

    isSettled(paymentHash: string): boolean {
      return settled.has(paymentHash)
    },

    settleWithCredit(paymentHash: string, amount: number, settlementSecret?: string): boolean {
      if (settled.has(paymentHash)) return false
      settled.set(paymentHash, settlementSecret)
      claims.delete(paymentHash)
      const current = balances.get(paymentHash) ?? 0
      balances.set(paymentHash, current + amount)
      return true
    },

    getSettlementSecret(paymentHash: string): string | undefined {
      return settled.get(paymentHash)
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

    storeInvoice(paymentHash: string, bolt11: string, amountSats: number, macaroon: string, statusToken: string, clientIp?: string): void {
      if (invoices.has(paymentHash)) return
      invoices.set(paymentHash, {
        paymentHash,
        bolt11,
        amountSats,
        macaroon,
        statusToken,
        createdAt: new Date().toISOString(),
      })
      if (clientIp) invoiceIps.set(paymentHash, clientIp)
    },

    pendingInvoiceCount(clientIp: string): number {
      let count = 0
      for (const [paymentHash, ip] of invoiceIps) {
        if (ip === clientIp && !settled.has(paymentHash)) count++
      }
      return count
    },

    getInvoice(paymentHash: string): StoredInvoice | undefined {
      const invoice = invoices.get(paymentHash)
      return invoice ? toStoredInvoice(invoice) : undefined
    },

    getInvoiceForStatus(paymentHash: string, statusToken: string): StoredInvoice | undefined {
      const invoice = invoices.get(paymentHash)
      if (!invoice) return undefined
      // Timing-safe comparison to prevent token enumeration via timing side-channel
      const storedBuf = Buffer.from(invoice.statusToken)
      const providedBuf = Buffer.from(statusToken)
      if (storedBuf.length !== providedBuf.length || !timingSafeEqual(storedBuf, providedBuf)) return undefined
      return toStoredInvoice(invoice)
    },

    pruneExpiredInvoices(maxAgeMs: number): number {
      const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
      let pruned = 0
      for (const [hash, inv] of invoices) {
        if (inv.createdAt < cutoff) {
          invoices.delete(hash)
          pruned++
        }
      }
      return pruned
    },

    pruneStaleRecords(_maxAgeMs: number): number {
      // Memory storage is for testing only — no long-running pruning needed
      return 0
    },

    close(): void {
      balances.clear()
      invoices.clear()
      invoiceIps.clear()
      settled.clear()
      claims.clear()
    },
  }
}
