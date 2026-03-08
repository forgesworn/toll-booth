// src/core/types.ts
import type { LightningBackend, CreditTier, PaymentEvent, RequestEvent, ChallengeEvent } from '../types.js'
import type { StorageBackend, StoredInvoice } from '../storage/interface.js'

export interface TollBoothRequest {
  method: string
  path: string
  headers: Record<string, string | undefined>
  ip: string
  body?: ReadableStream | null
}

export type TollBoothResult =
  | { action: 'proxy'; upstream: string; headers: Record<string, string>; creditBalance?: number; freeRemaining?: number }
  | { action: 'challenge'; status: 402; headers: Record<string, string>; body: Record<string, unknown> }
  | { action: 'pass'; upstream: string; headers: Record<string, string> }

export interface TollBoothCoreConfig {
  backend: LightningBackend
  storage: StorageBackend
  pricing: Record<string, number>
  upstream: string
  defaultInvoiceAmount?: number
  rootKey: string
  freeTier?: { requestsPerDay: number }
  creditTiers?: CreditTier[]
  onPayment?: (event: PaymentEvent) => void
  onRequest?: (event: RequestEvent) => void
  onChallenge?: (event: ChallengeEvent) => void
}

export interface CreateInvoiceRequest {
  amountSats?: number
}

export interface CreateInvoiceResult {
  success: boolean
  error?: string
  tiers?: CreditTier[]
  data?: {
    bolt11: string
    paymentHash: string
    paymentUrl: string
    amountSats: number
    creditSats: number
    macaroon: string
    qrSvg: string
  }
}

export interface InvoiceStatusResult {
  found: boolean
  paid: boolean
  preimage?: string
  invoice?: StoredInvoice
}
