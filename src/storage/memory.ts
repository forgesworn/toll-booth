// src/storage/memory.ts
import { timingSafeEqual } from 'node:crypto'
import type { Currency } from '../core/payment-rail.js'
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

interface DualBalance { sat: number; usd: number }

function getBalance(balances: Map<string, DualBalance>, paymentHash: string, currency: Currency): number {
  return balances.get(paymentHash)?.[currency] ?? 0
}

function setBalance(balances: Map<string, DualBalance>, paymentHash: string, currency: Currency, value: number): void {
  const entry = balances.get(paymentHash) ?? { sat: 0, usd: 0 }
  entry[currency] = value
  balances.set(paymentHash, entry)
}

export function memoryStorage(): StorageBackend {
  const balances = new Map<string, DualBalance>()
  const invoices = new Map<string, StoredInvoiceRecord>()
  const invoiceIps = new Map<string, string>()
  const settled = new Map<string, string | undefined>()
  const claims = new Map<string, { token: string; claimedAt: string; leaseExpiresAt: number }>()

  return {
    credit(paymentHash: string, amount: number, currency: Currency = 'sat'): void {
      if (amount <= 0) throw new RangeError('credit amount must be positive')
      const current = getBalance(balances, paymentHash, currency)
      setBalance(balances, paymentHash, currency, current + amount)
    },

    debit(paymentHash: string, amount: number, currency: Currency = 'sat'): DebitResult {
      const current = getBalance(balances, paymentHash, currency)
      if (current < amount) {
        return { success: false, remaining: current }
      }
      const remaining = current - amount
      setBalance(balances, paymentHash, currency, remaining)
      return { success: true, remaining }
    },

    balance(paymentHash: string, currency: Currency = 'sat'): number {
      return getBalance(balances, paymentHash, currency)
    },

    adjustCredits(paymentHash: string, delta: number, currency: Currency = 'sat'): number {
      const current = getBalance(balances, paymentHash, currency)
      const newBalance = Math.max(0, current + delta)
      setBalance(balances, paymentHash, currency, newBalance)
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

    settleWithCredit(paymentHash: string, amount: number, settlementSecret?: string, currency: Currency = 'sat'): boolean {
      if (amount < 0) throw new RangeError('settleWithCredit amount must not be negative')
      if (settled.has(paymentHash)) return false
      settled.set(paymentHash, settlementSecret)
      claims.delete(paymentHash)
      const current = getBalance(balances, paymentHash, currency)
      setBalance(balances, paymentHash, currency, current + amount)
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
      // Constant-time comparison: pad the shorter buffer so timingSafeEqual
      // always runs, preventing length-based timing side-channels.
      const storedBuf = Buffer.from(invoice.statusToken)
      const providedBuf = Buffer.from(statusToken)
      const maxLen = Math.max(storedBuf.length, providedBuf.length)
      const a = Buffer.alloc(maxLen)
      const b = Buffer.alloc(maxLen)
      storedBuf.copy(a)
      providedBuf.copy(b)
      if (storedBuf.length !== providedBuf.length || !timingSafeEqual(a, b)) return undefined
      return toStoredInvoice(invoice)
    },

    pruneExpiredInvoices(maxAgeMs: number): number {
      const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
      let pruned = 0
      for (const [hash, inv] of invoices) {
        if (inv.createdAt < cutoff && !claims.has(hash)) {
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
