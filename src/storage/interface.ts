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
  storeInvoice(paymentHash: string, bolt11: string, amountSats: number, macaroon: string): void
  getInvoice(paymentHash: string): StoredInvoice | undefined
  close(): void
}
