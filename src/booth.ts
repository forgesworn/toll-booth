// src/booth.ts
import type { BoothConfig, EventHandler } from './types.js'
import type { StorageBackend } from './storage/interface.js'
import type { TollBoothEngine } from './core/toll-booth.js'
import type { CreateInvoiceDeps } from './core/create-invoice.js'
import type { InvoiceStatusDeps } from './core/invoice-status.js'
import { createTollBooth } from './core/toll-booth.js'
import { sqliteStorage } from './storage/sqlite.js'
import { StatsCollector } from './stats.js'
import { randomBytes } from 'node:crypto'

import { createHonoMiddleware, createHonoInvoiceStatusHandler, createHonoCreateInvoiceHandler, createHonoNwcHandler, createHonoCashuHandler } from './adapters/hono.js'
import { createExpressMiddleware, createExpressInvoiceStatusHandler, createExpressCreateInvoiceHandler } from './adapters/express.js'
import { createWebStandardMiddleware, createWebStandardInvoiceStatusHandler, createWebStandardCreateInvoiceHandler } from './adapters/web-standard.js'

export type AdapterType = 'hono' | 'express' | 'web-standard'

export interface BoothOptions extends Omit<BoothConfig, 'dbPath'> {
  adapter: AdapterType
  storage?: StorageBackend
}

/**
 * Encapsulates the middleware, invoice-status handler, create-invoice handler,
 * and wallet adapter endpoints with shared internal state.
 *
 * The `adapter` option selects the framework integration:
 * - `'hono'` — Hono middleware and handlers
 * - `'express'` — Express middleware and handlers
 * - `'web-standard'` — Web Standards (Request/Response) handlers
 *
 * ```typescript
 * const booth = new Booth({ adapter: 'hono', ...config })
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

  constructor(config: BoothOptions & EventHandler) {
    const rootKeyInput = config.rootKey ?? randomBytes(32).toString('hex')
    if (!/^[0-9a-fA-F]{64}$/.test(rootKeyInput)) {
      throw new Error('rootKey must be exactly 64 hex characters (32 bytes)')
    }
    this.rootKey = rootKeyInput
    this.storage = config.storage ?? sqliteStorage()
    this.stats = new StatsCollector()

    const defaultAmount = config.defaultInvoiceAmount ?? 1000

    // Wire stats collection while preserving user-provided callbacks
    const userOnPayment = config.onPayment
    const userOnRequest = config.onRequest
    const userOnChallenge = config.onChallenge
    const stats = this.stats

    this.engine = createTollBooth({
      backend: config.backend,
      storage: this.storage,
      pricing: config.pricing,
      upstream: config.upstream,
      defaultInvoiceAmount: defaultAmount,
      rootKey: this.rootKey,
      freeTier: config.freeTier,
      creditTiers: config.creditTiers,
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
    }

    const invoiceStatusDeps: InvoiceStatusDeps = {
      backend: config.backend,
      storage: this.storage,
      tiers: config.creditTiers,
      nwcEnabled: !!config.nwcPayInvoice,
      cashuEnabled: !!config.redeemCashu,
    }

    const upstream = config.upstream.replace(/\/$/, '')

    switch (config.adapter) {
      case 'hono':
        this.middleware = createHonoMiddleware({ engine: this.engine, upstream })
        this.invoiceStatusHandler = createHonoInvoiceStatusHandler(invoiceStatusDeps)
        this.createInvoiceHandler = createHonoCreateInvoiceHandler(createInvoiceDeps)
        if (config.nwcPayInvoice) {
          this.nwcPayHandler = createHonoNwcHandler(config.nwcPayInvoice)
        }
        if (config.redeemCashu) {
          this.cashuRedeemHandler = createHonoCashuHandler(config.redeemCashu, this.storage)
        }
        break

      case 'express':
        this.middleware = createExpressMiddleware(this.engine, upstream)
        this.invoiceStatusHandler = createExpressInvoiceStatusHandler(invoiceStatusDeps)
        this.createInvoiceHandler = createExpressCreateInvoiceHandler(createInvoiceDeps)
        break

      case 'web-standard':
        this.middleware = createWebStandardMiddleware(this.engine, upstream)
        this.invoiceStatusHandler = createWebStandardInvoiceStatusHandler(invoiceStatusDeps)
        this.createInvoiceHandler = createWebStandardCreateInvoiceHandler(createInvoiceDeps)
        break
    }
  }

  /** Reset free-tier counters for all IPs. */
  resetFreeTier(): void {
    this.engine.freeTier?.reset()
  }

  /**
   * Recover Cashu redemptions that were claimed but never settled (crash recovery).
   * Call this on startup when Cashu is enabled. For each pending claim, retries
   * the redeem call and settles on success. Returns the number of recovered claims.
   */
  async recoverPendingClaims(
    redeemFn: (token: string, paymentHash: string) => Promise<number>,
  ): Promise<number> {
    const claims = this.storage.pendingClaims()
    let recovered = 0
    for (const claim of claims) {
      try {
        const credited = await redeemFn(claim.token, claim.paymentHash)
        this.storage.settleWithCredit(claim.paymentHash, credited)
        recovered++
      } catch {
        // Mint may reject (already redeemed) — settle with 0 to clear the claim
        this.storage.settleWithCredit(claim.paymentHash, 0)
      }
    }
    return recovered
  }

  close(): void {
    this.storage.close()
  }
}
