// src/core/toll-booth.ts
import { randomBytes } from 'node:crypto'
import { FreeTier, CreditFreeTier } from '../free-tier.js'
import type { IFreeTier } from '../free-tier.js'
import { createL402Rail } from './l402-rail.js'
import { normalisePricing, normalisePricingTable, isTieredPricing } from './payment-rail.js'
import type { Currency, PriceInfo, TieredPricing } from './payment-rail.js'
import type { TollBoothRequest, TollBoothResult, TollBoothCoreConfig, ReconcileResult } from './types.js'

export interface TollBoothEngine {
  handle(req: TollBoothRequest): Promise<TollBoothResult>
  reconcile(paymentHash: string, actualCost: number): ReconcileResult
  freeTier: IFreeTier | null
  upstream: string
}

/** Valid tier name: lowercase alphanumeric, hyphens, underscores; 1-32 chars. */
const TIER_NAME_RE = /^[a-z0-9_-]{1,32}$/

/** Normalise a single tier value (number or PriceInfo) to PriceInfo. */
function normaliseTierValue(value: number | PriceInfo): PriceInfo {
  return typeof value === 'number' ? { sats: value } : value
}

/** Build a normalised tiers map from a TieredPricing entry. */
function normaliseTiersMap(entry: TieredPricing): Record<string, PriceInfo> {
  const result: Record<string, PriceInfo> = {}
  for (const [key, value] of Object.entries(entry)) {
    result[key] = normaliseTierValue(value)
  }
  return result
}

export function createTollBooth(config: TollBoothCoreConfig): TollBoothEngine {
  // Validate tiered pricing entries: each must have a 'default' key
  for (const [route, entry] of Object.entries(config.pricing ?? {})) {
    if (typeof entry === 'object' && !('sats' in entry) && !('usd' in entry)) {
      // Looks like a tier map; verify it has 'default'
      if (!('default' in entry)) {
        throw new Error(`Tiered pricing for "${route}" must include a "default" key.`)
      }
    }
  }

  const defaultAmount = config.defaultInvoiceAmount ?? 1000
  const upstream = config.upstream.replace(/\/$/, '')
  const freeTier: IFreeTier | null = config.freeTier
    ? 'requestsPerDay' in config.freeTier
      ? new FreeTier(config.freeTier.requestsPerDay)
      : new CreditFreeTier(config.freeTier.creditsPerDay)
    : null
  const storage = config.storage

  // Booth always provides explicit rails. This fallback exists for direct
  // createTollBooth() users who don't pass rails (backward compat).
  const rails = config.rails ?? [
    createL402Rail({
      rootKey: config.rootKey,
      storage,
      defaultAmount,
      backend: config.backend,
      serviceName: config.serviceName,
    }),
  ]
  const normalisedPricing = config.normalisedPricing ?? normalisePricingTable(config.pricing ?? {})

  const MAX_ESTIMATED_COSTS = 10_000
  const MAX_AGE_MS = 60_000
  const estimatedCosts = new Map<string, { cost: number; ts: number; currency: Currency }>()

  return {
    freeTier,
    upstream,

    async handle(req: TollBoothRequest): Promise<TollBoothResult> {
      const start = Date.now()
      const path = req.path
      const pricedEntry = config.pricing[path]

      // Inner helper: issue a multi-rail 402 challenge for this route
      async function issueChallenge(): Promise<TollBoothResult> {
        const challengeHeaders: Record<string, string> = {}
        const challengeBody: Record<string, unknown> = {}

        const normalisedPrice = normalisedPricing[req.path] ?? { sats: defaultAmount }

        for (const rail of rails) {
          if (rail.canChallenge && !rail.canChallenge(normalisedPrice)) continue
          const fragment = await rail.challenge(req.path, normalisedPrice)
          Object.assign(challengeHeaders, fragment.headers)
          Object.assign(challengeBody, fragment.body)
        }

        challengeBody.message = 'Payment required.'

        // Include normalised tiers map for tiered routes
        if (pricedEntry !== undefined && isTieredPricing(pricedEntry)) {
          challengeBody.tiers = normaliseTiersMap(pricedEntry)
        }

        // Store invoice data from L402 rail if present
        const l402Data = challengeBody.l402 as Record<string, unknown> | undefined
        if (l402Data?.payment_hash) {
          const paymentHash = l402Data.payment_hash as string
          const statusToken = randomBytes(32).toString('hex')
          storage.storeInvoice(
            paymentHash,
            (l402Data.invoice as string) ?? '',
            defaultAmount,
            l402Data.macaroon as string,
            statusToken,
            req.ip,
          )
          l402Data.payment_url = `/invoice-status/${paymentHash}?token=${statusToken}`
          l402Data.status_token = statusToken
        }

        config.onChallenge?.({
          timestamp: new Date().toISOString(),
          endpoint: path,
          amountSats: defaultAmount,
          clientIp: req.ip,
        })

        return { action: 'challenge', status: 402, headers: challengeHeaders, body: challengeBody }
      }

      // Unpriced routes: pass through unless strictPricing is enabled
      if (pricedEntry === undefined && !config.strictPricing) {
        return { action: 'pass', upstream, headers: {} }
      }

      // Tier-aware pricing resolution
      let priceInfo: PriceInfo
      let resolvedTier: string | undefined

      if (pricedEntry !== undefined && isTieredPricing(pricedEntry)) {
        const tierKey = req.tier ?? 'default'

        // Validate tier name format
        if (tierKey !== 'default' && !TIER_NAME_RE.test(tierKey)) {
          return issueChallenge()
        }

        // Look up the requested tier
        if (!(tierKey in pricedEntry)) {
          return issueChallenge()
        }

        priceInfo = normaliseTierValue(pricedEntry[tierKey])
        resolvedTier = tierKey
      } else if (pricedEntry !== undefined) {
        priceInfo = normalisePricing(pricedEntry)
      } else {
        priceInfo = { sats: defaultAmount }
      }

      // Try each rail
      for (const rail of rails) {
        if (rail.detect(req)) {
          const result = await Promise.resolve(rail.verify(req))

          if (result.authenticated) {
            // Pick cost in the rail's currency
            const cost = result.currency === 'usd'
              ? (priceInfo.usd ?? 0)
              : (priceInfo.sats ?? defaultAmount)

            // Per-request replay protection: reject if already settled
            if (result.mode === 'per-request') {
              if (storage.isSettled(result.paymentId)) {
                break  // fall through to challenge
              }
              if (!storage.settle(result.paymentId)) {
                break  // lost race; another request settled first
              }
            }

            // Engine handles debit for credit mode
            if (result.mode === 'credit' && result.paymentId && cost > 0) {
              const debit = storage.debit(result.paymentId, cost, result.currency)
              if (!debit.success) {
                // Insufficient balance — fall through to challenge
                break
              }
            }

            const remaining = result.mode === 'credit'
              ? storage.balance(result.paymentId, result.currency)
              : undefined

            // Fire onPayment exactly once per paymentHash (first time seen)
            if (result.paymentId && !estimatedCosts.has(result.paymentId)) {
              const creditedAmount = (remaining ?? 0) + cost
              config.onPayment?.({
                timestamp: new Date().toISOString(),
                paymentHash: result.paymentId,
                amountSats: creditedAmount,
                currency: result.currency,
              })
            }

            // Track estimated cost with currency for reconciliation
            if (result.paymentId) {
              // Evict stale entries
              if (estimatedCosts.size >= MAX_ESTIMATED_COSTS) {
                const now = Date.now()
                for (const [key, entry] of estimatedCosts) {
                  if (now - entry.ts > MAX_AGE_MS) estimatedCosts.delete(key)
                }
              }
              estimatedCosts.set(result.paymentId, { cost, ts: Date.now(), currency: result.currency })
            }

            // Build response headers
            const headers: Record<string, string> = {}
            if (remaining !== undefined) {
              headers['X-Credit-Balance'] = String(remaining)
            }
            if (resolvedTier !== undefined) {
              headers['X-Toll-Tier'] = resolvedTier
            }
            if (result.customCaveats) {
              for (const [key, value] of Object.entries(result.customCaveats)) {
                if (/^[a-zA-Z0-9_]+$/.test(key)) {
                  headers[`X-Toll-Caveat-${key.charAt(0).toUpperCase() + key.slice(1)}`] = value.replace(/[\r\n]/g, '')
                }
              }
            }

            config.onRequest?.({
              timestamp: new Date().toISOString(),
              endpoint: path,
              satsDeducted: cost,
              remainingBalance: remaining ?? 0,
              latencyMs: Date.now() - start,
              authenticated: true,
              clientIp: req.ip,
              currency: result.currency,
              tier: resolvedTier,
            })

            return {
              action: 'proxy',
              upstream,
              headers,
              paymentHash: result.paymentId,
              estimatedCost: cost,
              creditBalance: remaining,
              tier: resolvedTier,
            }
          }

          // Rail detected credentials but verification failed — fall through to challenge
          break
        }
      }

      // No rail authenticated — check free tier
      if (freeTier) {
        const routeCost = normalisedPricing[req.path]?.sats ?? defaultAmount

        // NOTE: Credit-based free tier does not reconcile. The route cost
        // is debited upfront. If actual usage is lower, the difference is
        // not refunded to the daily budget. This is intentional — the free
        // tier is a quota, not a wallet.
        const check = freeTier.check(req.ip, routeCost)

        if (check.allowed) {
          config.onRequest?.({
            timestamp: new Date().toISOString(),
            endpoint: path,
            satsDeducted: freeTier instanceof CreditFreeTier ? routeCost : 0,
            remainingBalance: 0,
            latencyMs: Date.now() - start,
            authenticated: false,
            clientIp: req.ip,
          })
          return {
            action: 'proxy',
            upstream,
            headers: { 'X-Free-Remaining': String(check.remaining) },
            freeRemaining: check.remaining,
          }
        }
      }

      return issueChallenge()
    },

    reconcile(paymentHash: string, actualCost: number): ReconcileResult {
      const entry = estimatedCosts.get(paymentHash)
      if (entry === undefined) {
        return { adjusted: false, newBalance: storage.balance(paymentHash), delta: 0 }
      }
      const delta = entry.cost - actualCost
      if (delta === 0) {
        return { adjusted: false, newBalance: storage.balance(paymentHash, entry.currency), delta: 0 }
      }
      const newBalance = storage.adjustCredits(paymentHash, delta, entry.currency)
      if (delta < 0) {
        const unit = entry.currency === 'usd' ? 'cents' : 'sats'
        console.warn(`[toll-booth] Reconciliation: additional charge of ${-delta} ${unit} for ${paymentHash}, new balance ${newBalance}`)
      }
      estimatedCosts.delete(paymentHash)
      return { adjusted: true, newBalance, delta }
    },
  }
}
