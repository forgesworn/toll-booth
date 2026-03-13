import type { TollBoothRequest } from './types.js'

export type Currency = 'sat' | 'usd'

export interface PriceInfo {
  sats?: number
  usd?: number
}

/** A tier map: keys are tier names (must include 'default'), values are prices. */
export type TieredPricing = Record<string, number | PriceInfo>

/** Accepts number (backward-compat sats), PriceInfo, or a tiered pricing map. */
export type PricingEntry = number | PriceInfo | TieredPricing

/**
 * Type guard distinguishing TieredPricing from number | PriceInfo.
 *
 * PriceInfo uses 'sats' and/or 'usd' keys but never 'default', so the
 * presence of a 'default' key reliably identifies a tiered pricing map.
 */
export function isTieredPricing(entry: PricingEntry): entry is TieredPricing {
  if (typeof entry === 'number') return false
  return 'default' in entry
}

export type PricingTable = Record<string, PricingEntry>

/** Normalise a PricingEntry to PriceInfo. Numbers become { sats: n }. */
export function normalisePricing(entry: PricingEntry): PriceInfo {
  if (typeof entry === 'number') return { sats: entry }
  if (isTieredPricing(entry)) {
    const defaultValue = entry.default
    return typeof defaultValue === 'number' ? { sats: defaultValue } : defaultValue
  }
  return entry
}

/** Normalise an entire PricingTable. */
export function normalisePricingTable(table: PricingTable): Record<string, PriceInfo> {
  const result: Record<string, PriceInfo> = {}
  for (const [route, entry] of Object.entries(table)) {
    result[route] = normalisePricing(entry)
  }
  return result
}

export interface ChallengeFragment {
  headers: Record<string, string>
  body: Record<string, unknown>
}

export interface RailVerifyResult {
  authenticated: boolean
  paymentId: string
  mode: 'per-request' | 'credit'
  creditBalance?: number
  currency: Currency
  customCaveats?: Record<string, string>
}

export interface SettleResult {
  settled: boolean
  txHash?: string
}

export interface PaymentRail {
  type: string
  creditSupported: boolean
  /** Returns true if this rail can generate a challenge for the given price. */
  canChallenge?(price: PriceInfo): boolean
  challenge(route: string, price: PriceInfo): Promise<ChallengeFragment>
  detect(req: TollBoothRequest): boolean
  verify(req: TollBoothRequest): Promise<RailVerifyResult> | RailVerifyResult
  settle?(paymentId: string, amount: number): Promise<SettleResult>
}
