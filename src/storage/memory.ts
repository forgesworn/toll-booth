// src/storage/memory.ts
import type { StorageBackend, DebitResult, StoredInvoice } from './interface.js'

export function memoryStorage(): StorageBackend {
  const balances = new Map<string, number>()
  const invoices = new Map<string, StoredInvoice>()

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
    },
  }
}
