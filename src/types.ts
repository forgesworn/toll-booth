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
   * @param amountMsat - Amount in millisatoshis.
   * @param description - Human-readable invoice description.
   * @returns The created invoice.
   */
  createInvoice(amountMsat: number, description: string): Promise<Invoice>

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
  freeTier?: FreeTierConfig

  /**
   * Default invoice amount in millisatoshis, used when a route is not
   * listed in the pricing table. Required if any routes are not priced.
   */
  defaultInvoiceAmount?: number

  /**
   * Root key used for macaroon generation and verification.
   * If omitted, a random key is generated at startup (not recommended for
   * production use, as tokens will be invalidated on restart).
   */
  rootKey?: Uint8Array

  /**
   * Path to the SQLite database file used for invoice persistence.
   * Defaults to `lightning-gate.db` in the current working directory.
   */
  dbPath?: string
}

/**
 * Optional free-tier configuration. Requests satisfying all specified
 * criteria are allowed through without payment.
 */
export interface FreeTierConfig {
  /** Maximum number of free requests allowed per IP address per window. */
  requestsPerIp?: number
  /** Time window in seconds over which the free-tier limit applies. */
  windowSeconds?: number
}

/**
 * A record of a payment event stored for audit and idempotency purposes.
 */
export interface PaymentEvent {
  /** The payment hash identifying the invoice. */
  paymentHash: string
  /** The BOLT 11 payment request. */
  bolt11: string
  /** The amount requested in millisatoshis. */
  amountMsat: number
  /** Unix timestamp (seconds) when the invoice was created. */
  createdAt: number
  /** Unix timestamp (seconds) when the invoice was paid, or null if unpaid. */
  paidAt: number | null
  /** The payment preimage, present once the invoice has been paid. */
  preimage: string | null
}

/**
 * A record of an incoming HTTP request, used for rate-limiting and
 * free-tier tracking.
 */
export interface RequestEvent {
  /** A unique identifier for this request (e.g. a UUID). */
  id: string
  /** The client IP address. */
  ip: string
  /** The HTTP method (e.g. `"GET"`, `"POST"`). */
  method: string
  /** The request path (e.g. `"/api/resource"`). */
  path: string
  /** Unix timestamp (seconds) when the request was received. */
  receivedAt: number
  /** The payment hash of the token used to authorise this request, if any. */
  paymentHash: string | null
}
