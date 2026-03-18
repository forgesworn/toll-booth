// src/booth.ts
import type { BoothConfig, EventHandler } from './types.js'
import { normalisePricingTable } from './core/payment-rail.js'
import type { PaymentRail } from './core/payment-rail.js'
import type { StorageBackend } from './storage/interface.js'
import type { TollBoothEngine } from './core/toll-booth.js'
import type { CreateInvoiceDeps } from './core/create-invoice.js'
import type { InvoiceStatusDeps } from './core/invoice-status.js'
import { createTollBooth } from './core/toll-booth.js'
import { createL402Rail } from './core/l402-rail.js'
import { createX402Rail } from './core/x402-rail.js'
import { createXCashuRail } from './core/xcashu-rail.js'
import { sqliteStorage } from './storage/sqlite.js'
import { StatsCollector } from './stats.js'
import { randomBytes } from 'node:crypto'
import { REDEEM_LEASE_MS } from './core/cashu-redeem.js'

import {
  createExpressMiddleware,
  createExpressInvoiceStatusHandler,
  createExpressCreateInvoiceHandler,
  createExpressNwcHandler,
  createExpressCashuHandler,
} from './adapters/express.js'
import {
  createWebStandardMiddleware,
  createWebStandardInvoiceStatusHandler,
  createWebStandardCreateInvoiceHandler,
  createWebStandardNwcHandler,
  createWebStandardCashuHandler,
} from './adapters/web-standard.js'

/**
 * Shannon entropy over the raw bytes of a hex-encoded key.
 * Returns true if the key has dangerously low entropy (< 2.0 bits per byte).
 * A 32-byte key from `crypto.randomBytes(32)` typically has ~7.5+ bits/byte.
 */
function hasLowEntropy(hexKey: string): boolean {
  const bytes = Buffer.from(hexKey, 'hex')
  const freq = new Map<number, number>()
  for (const b of bytes) {
    freq.set(b, (freq.get(b) ?? 0) + 1)
  }
  let entropy = 0
  for (const count of freq.values()) {
    const p = count / bytes.length
    entropy -= p * Math.log2(p)
  }
  return entropy < 2.0
}

export type AdapterType = 'express' | 'web-standard'

export interface BoothOptions extends BoothConfig {
  adapter: AdapterType
  storage?: StorageBackend
}

/**
 * Encapsulates the middleware, invoice-status handler, create-invoice handler,
 * and wallet adapter endpoints with shared internal state.
 *
 * The `adapter` option selects the framework integration:
 * - `'express'` — Express middleware and handlers
 * - `'web-standard'` — Web Standards (Request/Response) handlers
 *
 * ```typescript
 * const booth = new Booth({ adapter: 'express', ...config })
 * app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler)
 * app.post('/create-invoice', booth.createInvoiceHandler)
 * app.use('/*', booth.middleware)
 * ```
 */
export class Booth {
  readonly middleware: unknown
  readonly invoiceStatusHandler: unknown
  readonly createInvoiceHandler: unknown
  readonly nwcPayHandler?: unknown
  readonly cashuRedeemHandler?: unknown

  /** Aggregate usage statistics. Resets on restart. */
  readonly stats: StatsCollector

  private readonly storage: StorageBackend
  private readonly engine: TollBoothEngine
  private readonly rootKey: string
  private readonly redeemCashu?: (token: string, paymentHash: string) => Promise<number>
  private readonly pruneTimer?: ReturnType<typeof setInterval>
  private closed = false

  constructor(config: BoothOptions & EventHandler) {
    if (!config.backend && !config.redeemCashu && !config.x402 && !config.xcashu) {
      throw new Error('At least one payment method required: provide a Lightning backend, redeemCashu callback, x402 config, or xcashu config')
    }

    let rootKeyInput: string
    if (config.rootKey) {
      rootKeyInput = config.rootKey
    } else {
      rootKeyInput = randomBytes(32).toString('hex')
      console.warn(
        '[toll-booth] WARNING: rootKey not provided; auto-generated a random key. ' +
        'All macaroons will be invalidated on restart. Set ROOT_KEY for production use.',
      )
    }
    if (!/^[0-9a-fA-F]{64}$/.test(rootKeyInput)) {
      throw new Error('rootKey must be exactly 64 hex characters (32 bytes)')
    }
    this.rootKey = rootKeyInput.toLowerCase()

    // Warn on trivially weak keys
    if (hasLowEntropy(this.rootKey)) {
      console.warn(
        '[toll-booth] WARNING: rootKey has very low entropy. ' +
        'Use a cryptographically random key for production.',
      )
    }

    if (config.storage && config.dbPath) {
      throw new Error('Provide either storage or dbPath, not both')
    }
    this.storage = config.storage ?? sqliteStorage({ path: config.dbPath ?? './toll-booth.db' })
    this.stats = new StatsCollector()

    const defaultAmount = config.defaultInvoiceAmount ?? 1000

    // Wire stats collection while preserving user-provided callbacks
    const userOnPayment = config.onPayment
    const userOnRequest = config.onRequest
    const userOnChallenge = config.onChallenge
    const stats = this.stats

    const normalisedPricing = normalisePricingTable(config.pricing)

    // Build payment rails array
    const rails: PaymentRail[] = []

    if (config.backend || config.redeemCashu) {
      rails.push(createL402Rail({ rootKey: this.rootKey, storage: this.storage, defaultAmount, backend: config.backend, serviceName: config.serviceName }))
    }

    if (config.x402) {
      rails.push(createX402Rail({ ...config.x402, storage: this.storage }))
    }

    if (config.xcashu) {
      rails.push(createXCashuRail(config.xcashu, this.storage))
    }

    this.engine = createTollBooth({
      backend: config.backend,
      storage: this.storage,
      pricing: config.pricing,
      normalisedPricing,
      upstream: config.upstream,
      defaultInvoiceAmount: defaultAmount,
      rootKey: this.rootKey,
      freeTier: config.freeTier,
      strictPricing: config.strictPricing,
      creditTiers: config.creditTiers,
      serviceName: config.serviceName,
      description: config.description,
      blockedCountries: config.blockedCountries,
      countryHeader: config.countryHeader,
      rails,
      onPayment: (event) => {
        stats.recordPayment(event)
        userOnPayment?.(event)
      },
      onRequest: (event) => {
        stats.recordRequest(event)
        userOnRequest?.(event)
      },
      onChallenge: (event) => {
        stats.recordChallenge(event)
        userOnChallenge?.(event)
      },
    })

    const createInvoiceDeps: CreateInvoiceDeps = {
      backend: config.backend,
      storage: this.storage,
      rootKey: this.rootKey,
      tiers: config.creditTiers ?? [],
      defaultAmount,
      maxPendingPerIp: config.invoiceRateLimit?.maxPendingPerIp,
      serviceName: config.serviceName,
    }

    const invoiceStatusDeps: InvoiceStatusDeps = {
      backend: config.backend,
      storage: this.storage,
      tiers: config.creditTiers,
      nwcEnabled: !!config.nwcPayInvoice,
      cashuEnabled: !!config.redeemCashu,
    }

    const upstream = config.upstream.replace(/\/$/, '')

    const adapterConfig = {
      engine: this.engine,
      upstream,
      trustProxy: config.trustProxy,
      getClientIp: config.getClientIp,
      responseHeaders: config.responseHeaders,
      upstreamTimeout: config.upstreamTimeout,
    }

    const nwcPayDeps = config.nwcPayInvoice
      ? { nwcPay: config.nwcPayInvoice, storage: this.storage }
      : undefined

    const cashuRedeemDeps = config.redeemCashu
      ? { redeem: config.redeemCashu, storage: this.storage }
      : undefined

    switch (config.adapter) {
      case 'express':
        this.middleware = createExpressMiddleware(adapterConfig)
        this.invoiceStatusHandler = createExpressInvoiceStatusHandler(invoiceStatusDeps)
        this.createInvoiceHandler = createExpressCreateInvoiceHandler({
          deps: createInvoiceDeps,
          trustProxy: config.trustProxy,
          getClientIp: config.getClientIp,
        })
        if (nwcPayDeps) this.nwcPayHandler = createExpressNwcHandler(nwcPayDeps)
        if (cashuRedeemDeps) {
          this.redeemCashu = config.redeemCashu
          this.cashuRedeemHandler = createExpressCashuHandler(cashuRedeemDeps)
        }
        break

      case 'web-standard':
        this.middleware = createWebStandardMiddleware(adapterConfig)
        this.invoiceStatusHandler = createWebStandardInvoiceStatusHandler(invoiceStatusDeps)
        this.createInvoiceHandler = createWebStandardCreateInvoiceHandler({
          deps: createInvoiceDeps,
          trustProxy: config.trustProxy,
          getClientIp: config.getClientIp,
        })
        if (nwcPayDeps) this.nwcPayHandler = createWebStandardNwcHandler(nwcPayDeps)
        if (cashuRedeemDeps) {
          this.redeemCashu = config.redeemCashu
          this.cashuRedeemHandler = createWebStandardCashuHandler(cashuRedeemDeps)
        }
        break
    }

    // Invoice expiry pruning
    const maxAge = config.invoiceMaxAgeMs ?? 86_400_000 // 24 hours
    if (maxAge > 0) {
      const timer = setInterval(() => {
        this.storage.pruneExpiredInvoices(maxAge)
        this.storage.pruneStaleRecords(maxAge)
      }, 3_600_000) // every hour
      timer.unref()
      this.pruneTimer = timer
    }

    // Auto-recover any pending Cashu claims from a previous crash
    if (this.redeemCashu) {
      const fn = this.redeemCashu
      this.recoverPendingClaims(fn).catch((err) => {
        console.warn('[toll-booth] Cashu recovery failed:', err instanceof Error ? err.message : err)
      })
    }
  }

  /** Reset free-tier counters for all IPs. */
  resetFreeTier(): void {
    this.engine.freeTier?.reset()
  }

  /**
   * Recover Cashu redemptions that were claimed but never settled (crash recovery).
   * Automatically called on startup when Cashu is enabled. Can also be called
   * manually. This requires an idempotent `redeemCashu` implementation keyed by
   * `paymentHash`. For each pending claim, retries the redeem call:
   * - If recovery lease is acquired: attempts redeem
   * - On success: settles with the credited amount
   * - On failure: leaves the claim pending for the next recovery attempt
   *
   * Returns the number of successfully recovered claims.
   */
  async recoverPendingClaims(
    redeemFn: (token: string, paymentHash: string) => Promise<number>,
  ): Promise<number> {
    const claims = this.storage.pendingClaims()
    let recovered = 0
    const renewIntervalMs = Math.max(1_000, Math.floor(REDEEM_LEASE_MS / 2))
    for (const claim of claims) {
      if (this.closed) break

      // Respect active leases so startup recovery does not race in-flight requests
      // (or another process already handling this claim).
      const leasedClaim = this.storage.tryAcquireRecoveryLease(claim.paymentHash, REDEEM_LEASE_MS)
      if (!leasedClaim) continue

      const timer = setInterval(() => {
        if (this.closed) { clearInterval(timer); return }
        this.storage.extendRecoveryLease(leasedClaim.paymentHash, REDEEM_LEASE_MS)
      }, renewIntervalMs)

      try {
        const credited = await redeemFn(leasedClaim.token, leasedClaim.paymentHash)
        // Guard against overpayment (same check as handleCashuRedeem)
        const invoice = this.storage.getInvoice(leasedClaim.paymentHash)
        if (invoice?.amountSats !== undefined && credited > invoice.amountSats) {
          console.warn(
            `[toll-booth] Recovery: rejecting overpayment for ${leasedClaim.paymentHash}: ` +
            `expected ${invoice.amountSats}, got ${credited}`,
          )
          continue
        }
        if (this.storage.settleWithCredit(leasedClaim.paymentHash, credited)) {
          recovered++
        }
      } catch {
        // Transient failure (network, mint outage) — leave claim pending
        // for the next recovery attempt. Do NOT settle with 0.
      } finally {
        clearInterval(timer)
      }
    }
    return recovered
  }

  close(): void {
    this.closed = true
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.storage.close()
  }
}
