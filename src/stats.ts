// src/stats.ts
import type { PaymentEvent, RequestEvent, ChallengeEvent } from './types.js'

/** Maximum number of distinct endpoint paths tracked in stats. */
const MAX_TRACKED_ENDPOINTS = 1000

/**
 * Aggregate statistics snapshot from a toll-booth instance.
 *
 * All counters are in-memory and reset on restart — no PII is stored.
 */
export interface BoothStats {
  /** ISO 8601 timestamp when the booth started. */
  upSince: string

  requests: {
    /** Total requests handled (authenticated + free tier). */
    total: number
    /** Requests authenticated with a valid L402 token. */
    authenticated: number
    /** Requests served under the free tier allowance. */
    freeTier: number
    /** 402 challenges issued (invoices created). */
    challenged: number
  }

  revenue: {
    /** Lightning invoices settled via L402 preimage. */
    invoicesPaid: number
    /** Payments made via Nostr Wallet Connect. */
    nwcPayments: number
    /** Payments made via Cashu token redemption. */
    cashuRedemptions: number
    /** Total satoshis credited to balances. */
    totalCredited: number
    /** Total satoshis consumed by requests. */
    totalConsumed: number
  }

  /** Per-endpoint breakdown of usage. */
  endpoints: Record<string, { requests: number; satsConsumed: number }>
}

/**
 * Lightweight in-memory statistics collector for toll-booth.
 *
 * Aggregates request, payment, and challenge events into counters
 * with no personally identifiable information. Resets on process restart.
 */
export class StatsCollector {
  private readonly upSince: string
  private requests = { total: 0, authenticated: 0, freeTier: 0, challenged: 0 }
  private revenue = {
    invoicesPaid: 0,
    nwcPayments: 0,
    cashuRedemptions: 0,
    totalCredited: 0,
    totalConsumed: 0,
  }
  private endpoints = new Map<string, { requests: number; satsConsumed: number }>()

  constructor() {
    this.upSince = new Date().toISOString()
  }

  /** Record a proxied request (authenticated or free tier). */
  recordRequest(event: RequestEvent): void {
    this.requests.total++
    if (event.authenticated) {
      this.requests.authenticated++
    } else {
      this.requests.freeTier++
    }

    const existing = this.endpoints.get(event.endpoint)
    if (existing) {
      existing.requests++
      existing.satsConsumed += event.satsDeducted
    } else if (this.endpoints.size < MAX_TRACKED_ENDPOINTS) {
      this.endpoints.set(event.endpoint, { requests: 1, satsConsumed: event.satsDeducted })
    }

    this.revenue.totalConsumed += event.satsDeducted
  }

  /** Record a Lightning invoice settlement (credit granted). */
  recordPayment(event: PaymentEvent): void {
    this.revenue.invoicesPaid++
    this.revenue.totalCredited += event.amountSats
  }

  /** Record a 402 challenge issued. */
  recordChallenge(_event: ChallengeEvent): void {
    this.requests.challenged++
  }

  /** Record a successful NWC payment. */
  recordNwcPayment(amountSats: number): void {
    this.revenue.nwcPayments++
    this.revenue.totalCredited += amountSats
  }

  /** Record a successful Cashu token redemption. */
  recordCashuRedemption(amountSats: number): void {
    this.revenue.cashuRedemptions++
    this.revenue.totalCredited += amountSats
  }

  /** Return a frozen snapshot of current statistics. */
  snapshot(): BoothStats {
    const endpoints: Record<string, { requests: number; satsConsumed: number }> = {}
    for (const [path, counters] of this.endpoints) {
      endpoints[path] = { ...counters }
    }

    return {
      upSince: this.upSince,
      requests: { ...this.requests },
      revenue: { ...this.revenue },
      endpoints,
    }
  }
}
