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
  storeInvoice(paymentHash: string, bolt11: string, amountSats: number, macaroon: string): void
  getInvoice(paymentHash: string): StoredInvoice | undefined
  close(): void
}
