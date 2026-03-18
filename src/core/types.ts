// src/core/types.ts
import { createHash } from 'node:crypto'
import type { LightningBackend, CreditTier, PaymentEvent, RequestEvent, ChallengeEvent } from '../types.js'
import type { StorageBackend, StoredInvoice } from '../storage/interface.js'
import type { PaymentRail, PriceInfo, PricingEntry } from './payment-rail.js'

/** Matches a valid 64-char lowercase hex payment hash. */
export const PAYMENT_HASH_RE = /^[0-9a-f]{64}$/

/**
 * One-way hash of an IP address with a daily-rotating salt.
 * Rate limiting still works (same IP produces same hash within a day),
 * but the raw IP cannot be recovered from storage.
 */
export function hashIp(ip: string): string {
  const daySalt = new Date().toISOString().slice(0, 10)
  return createHash('sha256').update(`${daySalt}:${ip}`).digest('hex').slice(0, 32)
}

export interface TollBoothRequest {
  method: string
  path: string
  headers: Record<string, string | undefined>
  ip: string
  body?: ReadableStream | null
  tier?: string
}

export type TollBoothResult =
  | { action: 'proxy'; upstream: string; headers: Record<string, string>; paymentHash?: string; estimatedCost?: number; creditBalance?: number; freeRemaining?: number; tier?: string }
  | { action: 'challenge'; status: 401 | 402; headers: Record<string, string>; body: Record<string, unknown> }
  | { action: 'pass'; upstream: string; headers: Record<string, string> }
  | { action: 'blocked'; status: 403; body: Record<string, unknown> }

export interface ReconcileResult {
  adjusted: boolean
  newBalance: number
  delta: number
}

export interface TollBoothCoreConfig {
  /** Lightning backend. Optional when Cashu-only mode is used. */
  backend?: LightningBackend
  storage: StorageBackend
  pricing: Record<string, PricingEntry>
  upstream: string
  defaultInvoiceAmount?: number
  strictPricing?: boolean
  rootKey: string
  freeTier?: { requestsPerDay: number } | { creditsPerDay: number }
  creditTiers?: CreditTier[]
  rails?: PaymentRail[]
  normalisedPricing?: Record<string, PriceInfo>
  /** Human-readable service name for invoice descriptions. Defaults to 'toll-booth'. */
  serviceName?: string
  /** Service description for 402 response bodies. */
  description?: string
  /** ISO 3166-1 alpha-2 country codes to block. Requests from these countries receive 403. */
  blockedCountries?: readonly string[]
  /** HTTP header containing the country code. Set by reverse proxy/CDN. Default: 'CF-IPCountry'. */
  countryHeader?: string
  onPayment?: (event: PaymentEvent) => void
  onRequest?: (event: RequestEvent) => void
  onChallenge?: (event: ChallengeEvent) => void
}

export interface CreateInvoiceRequest {
  amountSats?: number
  caveats?: string[]
  /** Injected by adapter; not client-settable. Used for invoice rate limiting. */
  clientIp?: string
}

export interface CreateInvoiceResult {
  success: boolean
  error?: string
  /** HTTP status code hint for the adapter. Defaults to 400 on error. */
  status?: number
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
  tokenSuffix?: string
  invoice?: StoredInvoice
}

export interface NwcPayRequest {
  nwcUri: string
  bolt11: string
  paymentHash: string
  statusToken: string
}

export type NwcPayResult =
  | { success: true; preimage: string }
  | { success: false; error: string; status: 400 | 500 }

export interface CashuRedeemRequest {
  token: string
  paymentHash: string
  statusToken: string
}

export type CashuRedeemResult =
  | { success: true; credited: number; tokenSuffix: string }
  | { success: false; state: 'pending'; retryAfterMs: number }
  | { success: false; error: string; status: 400 | 500 }
