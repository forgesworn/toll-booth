/**
 * Core type definitions for lightning-gate.
 *
 * lightning-gate is a generic L402 Lightning payment middleware for gating
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
 * Pricing table mapping route patterns to amounts in millisatoshis.
 *
 * Keys are route patterns (e.g. `"GET /api/resource"`) and values are the
 * required payment amount in millisatoshis.
 */
export type PricingTable = Record<string, number>

/**
 * Configuration for a lightning-gate instance.
 */
export interface GateConfig {
  /** The Lightning backend to use for invoice creation and status checks. */
  backend: LightningBackend

  /**
   * Pricing table mapping route patterns to amounts in millisatoshis.
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
   * Default invoice amount in millisatoshis, used when a route is not
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
   * Defaults to `lightning-gate.db` in the current working directory.
   */
  dbPath?: string
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
