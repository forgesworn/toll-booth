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

/**
 * Pricing table mapping route patterns to amounts in satoshis.
 *
 * Keys are route patterns (e.g. `"/route"`) and values are the
 * required payment amount in satoshis.
 */
export type PricingTable = Record<string, number>

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
}

/**
 * Configuration for a toll-booth instance.
 */
export interface BoothConfig {
  /** The Lightning backend to use for invoice creation and status checks. */
  backend: LightningBackend

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
  freeTier?: { requestsPerDay: number }

  /**
   * Default invoice amount in satoshis, used when a route is not
   * listed in the pricing table. Required if any routes are not priced.
   */
  defaultInvoiceAmount?: number

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
   * Optional shared secret for `/stats` and `/admin/reset-free-tier`.
   * When set, send `Authorization: Bearer <token>` or `X-Admin-Token`.
   */
  adminToken?: string

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
   * Returns the credited amount in satoshis.
   * When provided, the payment page shows a Cashu option.
   */
  redeemCashu?: (token: string, paymentHash: string) => Promise<number>

  /**
   * Timeout in milliseconds for upstream proxy requests.
   * Defaults to 30000 (30 seconds).
   */
  upstreamTimeout?: number
}

/**
 * A record of a payment event stored for audit and idempotency purposes.
 */
export interface PaymentEvent {
  timestamp: string
  paymentHash: string
  amountSats: number
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
}

/**
 * A record of a 402 challenge issued to a client.
 */
export interface ChallengeEvent {
  timestamp: string
  endpoint: string
  amountSats: number
}
