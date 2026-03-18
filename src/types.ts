/**
 * Core type definitions for toll-booth.
 *
 * toll-booth is a generic L402 Lightning payment middleware for gating
 * any HTTP API behind a Lightning Network paywall.
 */

/**
 * A Lightning invoice returned from a backend after creation.
 */
export interface Invoice {
  /** The BOLT 11 payment request string. */
  bolt11: string
  /** The payment hash that identifies this invoice. */
  paymentHash: string
}

/**
 * The current status of a Lightning invoice.
 */
export interface InvoiceStatus {
  /** Whether the invoice has been paid. */
  paid: boolean
  /** The payment preimage, present only if the invoice has been paid. */
  preimage?: string
}

/**
 * Abstraction over a Lightning node backend.
 *
 * Implement this interface to add support for a new Lightning node type
 * (e.g. phoenixd, LND, CLN).
 */
export interface LightningBackend {
  /**
   * Create a new Lightning invoice for the given amount.
   * @param amountSats - Amount in satoshis.
   * @param memo - Optional human-readable invoice description.
   * @returns The created invoice.
   */
  createInvoice(amountSats: number, memo?: string): Promise<Invoice>

  /**
   * Check the payment status of an existing invoice.
   * @param paymentHash - The payment hash of the invoice to check.
   * @returns The current invoice status.
   */
  checkInvoice(paymentHash: string): Promise<InvoiceStatus>
}

import type { Proof } from '@cashu/cashu-ts'
import type { Currency, PricingEntry } from './core/payment-rail.js'
import type { X402RailConfig } from './core/x402-types.js'

/**
 * Pricing table mapping route patterns to amounts.
 *
 * Keys are route patterns (e.g. `"/route"`). Values are either a number
 * (satoshis, backward-compatible) or a PriceInfo object for dual-currency
 * pricing (e.g. `{ sats: 10, usd: 1 }`).
 */
export type PricingTable = Record<string, PricingEntry>

/**
 * A credit tier offering volume discounts.
 *
 * The `amountSats` is what the user pays; `creditSats` is what they receive.
 * When `creditSats > amountSats`, the difference is the volume discount.
 */
export interface CreditTier {
  /** Amount the user pays in satoshis. */
  amountSats: number
  /** Credits received in satoshis (may exceed amountSats for volume discounts). */
  creditSats: number
  /** Human-readable label for this tier. */
  label: string
  /** x402 tier amount in cents (USD). */
  amountUsd?: number
  /** x402 tier credit in cents (USD). */
  creditUsd?: number
  /** What the agent gets for this tier, e.g. "1 request", "10 minutes access". */
  yields?: string
}

/**
 * Configuration for the xcashu (NUT-24) payment rail.
 */
export interface XCashuConfig {
  /** Accepted Cashu mint URLs (1+) */
  mints: string[]
  /** Currency unit, default 'sat' */
  unit?: Currency
  /**
   * Called after successful token swap with the server-side proofs.
   * Fire-and-forget — the rail does NOT await this callback.
   * Use for melting, persisting, or forwarding received ecash.
   */
  onProofsReceived?: (proofs: Proof[], mintUrl: string, amount: number) => void | Promise<void>
}

/**
 * Configuration for a toll-booth instance.
 */
export interface BoothConfig {
  /**
   * The Lightning backend to use for invoice creation and status checks.
   * Optional when using Cashu-only mode (`redeemCashu` provided without a backend).
   */
  backend?: LightningBackend

  /**
   * Pricing table mapping route patterns to amounts in satoshis.
   * Routes not listed here use `defaultInvoiceAmount` if set.
   */
  pricing: PricingTable

  /** The upstream URL to proxy authorised requests to. */
  upstream: string

  /**
   * Optional free-tier configuration. Requests matching these criteria
   * bypass the payment requirement.
   */
  freeTier?: { requestsPerDay: number } | { creditsPerDay: number }

  /**
   * Default invoice amount in satoshis. Controls how many credits are
   * minted per invoice, and is also used as the route cost when
   * `strictPricing` challenges an unpriced route.
   */
  defaultInvoiceAmount?: number

  /**
   * When true, unpriced routes are challenged (402) using `defaultInvoiceAmount`
   * as the cost, instead of being passed through for free. This prevents
   * mount-prefix mismatches or typos from silently bypassing billing.
   */
  strictPricing?: boolean

  /**
   * Root key used for macaroon generation and verification, as a
   * hex-encoded 32-byte string.
   * If omitted, a random key is generated at startup (not recommended for
   * production use, as tokens will be invalidated on restart).
   */
  rootKey?: string

  /**
   * Path to the SQLite database file used for invoice persistence.
   * Defaults to `./toll-booth.db` in the current working directory.
   */
  dbPath?: string

  /**
   * Trust reverse-proxy headers (`X-Forwarded-For` / `X-Real-IP`) for client IP.
   * Keep disabled unless a trusted proxy overwrites these headers.
   */
  trustProxy?: boolean

  /**
   * Custom callback to resolve the client IP for adapters that cannot infer
   * it directly (for example Deno, Bun, or Cloudflare Workers).
   * The callback receives the adapter-specific request object.
   */
  getClientIp?: (request: unknown) => string

  /**
   * Extra headers to include on every response (e.g. `{ 'X-Coverage': 'GB' }`).
   * Replaces the previously hardcoded `X-Coverage: GB` header.
   */
  responseHeaders?: Record<string, string>

  /**
   * Credit tiers with optional volume discounts.
   * Used by the payment page tier selector and the `/create-invoice` endpoint.
   */
  creditTiers?: CreditTier[]

  /**
   * Pay a Lightning invoice via Nostr Wallet Connect.
   * Accepts NWC URI + bolt11, returns the payment preimage.
   * When provided, the payment page shows an NWC option.
   */
  nwcPayInvoice?: (nwcUri: string, bolt11: string) => Promise<string>

  /**
   * Redeem a Cashu token as payment.
   * Returns the credited amount in satoshis. Implementations should be
   * idempotent for the same `paymentHash` if you rely on retry/recovery.
   * When provided, the payment page shows a Cashu option.
   */
  redeemCashu?: (token: string, paymentHash: string) => Promise<number>

  /** x402 stablecoin payment rail configuration. */
  x402?: X402RailConfig

  /**
   * xcashu (NUT-24) config — accept Cashu ecash via X-Cashu header.
   * Proofs are swapped at the configured mint(s) using cashu-ts.
   */
  xcashu?: XCashuConfig

  /**
   * Human-readable service name used in Lightning invoice descriptions.
   * Defaults to `'toll-booth'`. Example: `'satgate'` produces invoices
   * like `"satgate: 1000 sats credit"`.
   */
  serviceName?: string

  /**
   * Service description shown in 402 response bodies.
   * Only included when `serviceName` is also set.
   */
  description?: string

  /**
   * Timeout in milliseconds for upstream proxy requests.
   * Defaults to 30000 (30 seconds).
   */
  upstreamTimeout?: number

  /**
   * Maximum age of stored invoices in milliseconds. Invoices older than
   * this are periodically pruned. Set to 0 to disable pruning.
   * Default: 86400000 (24 hours).
   */
  invoiceMaxAgeMs?: number

  /**
   * Rate limit for invoice creation. When configured, limits the number of
   * pending (unpaid) invoices per client IP.
   */
  invoiceRateLimit?: { maxPendingPerIp: number }

  /**
   * Optional list of ISO 3166-1 alpha-2 country codes to block.
   * Requests from these countries receive 403 Forbidden.
   * Country is determined from the header specified by `countryHeader`.
   * If not set, no geo-blocking is applied.
   *
   * @example blockedCountries: OFAC_SANCTIONED
   * @example blockedCountries: [...OFAC_SANCTIONED, 'BY']
   */
  blockedCountries?: readonly string[]

  /**
   * HTTP header containing the ISO 3166-1 alpha-2 country code.
   * Typically set by a reverse proxy or CDN (e.g. Cloudflare, nginx GeoIP2).
   * Default: 'CF-IPCountry'.
   */
  countryHeader?: string
}

/**
 * A record of a payment event stored for audit and idempotency purposes.
 */
export interface PaymentEvent {
  timestamp: string
  paymentHash: string
  amountSats: number
  currency?: Currency  // 'sat' | 'usd', defaults to 'sat'
  rail?: string        // 'l402' | 'x402' | custom
}

/**
 * A record of an incoming HTTP request, used for analytics and
 * free-tier tracking.
 */
export interface RequestEvent {
  timestamp: string
  endpoint: string
  satsDeducted: number
  remainingBalance: number
  latencyMs: number
  authenticated: boolean
  currency?: Currency
  tier?: string
}

/**
 * A record of a 402 challenge issued to a client.
 */
export interface ChallengeEvent {
  timestamp: string
  endpoint: string
  amountSats: number
}

/**
 * Optional event handlers for observing toll-booth lifecycle events.
 */
export type EventHandler = {
  onPayment?: (event: PaymentEvent) => void
  onRequest?: (event: RequestEvent) => void
  onChallenge?: (event: ChallengeEvent) => void
}
