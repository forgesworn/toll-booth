// src/booth.ts
import type { Context } from 'hono'
import type { BoothConfig } from './types.js'
import type { EventHandler } from './middleware.js'
import { tollBooth } from './middleware.js'
import { FreeTier } from './free-tier.js'
import { invoiceStatus } from './invoice-status.js'
import { createInvoiceHandler } from './create-invoice.js'
import { CreditMeter } from './meter.js'
import { InvoiceStore } from './invoice-store.js'
import { StatsCollector } from './stats.js'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'

/**
 * Encapsulates the middleware, invoice-status handler, create-invoice handler,
 * and wallet adapter endpoints with shared internal state.
 *
 * ```typescript
 * const booth = new Booth(config)
 * app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler)
 * app.post('/create-invoice', booth.createInvoiceHandler)
 * // Optional wallet adapter endpoints
 * if (config.nwcPayInvoice) app.post('/nwc-pay', booth.nwcPayHandler!)
 * if (config.redeemCashu) app.post('/cashu-redeem', booth.cashuRedeemHandler!)
 * app.use('/*', booth.middleware)
 * ```
 */
export class Booth {
  readonly middleware: ReturnType<typeof tollBooth>
  readonly invoiceStatusHandler: ReturnType<typeof invoiceStatus>
  readonly createInvoiceHandler: ReturnType<typeof createInvoiceHandler>
  readonly nwcPayHandler?: (c: Context) => Promise<Response>
  readonly cashuRedeemHandler?: (c: Context) => Promise<Response>

  /** Aggregate usage statistics. Resets on restart. */
  readonly stats: StatsCollector

  private readonly db: Database.Database
  private readonly meter: CreditMeter
  private readonly invoiceStore: InvoiceStore
  private readonly rootKey: string
  private readonly freeTier: FreeTier | null
  private readonly trustProxy: boolean
  private readonly adminToken?: string

  constructor(config: BoothConfig & EventHandler) {
    this.rootKey = config.rootKey ?? randomBytes(32).toString('hex')
    this.db = new Database(config.dbPath ?? './toll-booth.db')
    this.db.pragma('journal_mode = WAL')
    this.meter = new CreditMeter(this.db)
    this.invoiceStore = new InvoiceStore(this.db)
    this.stats = new StatsCollector()
    this.trustProxy = config.trustProxy ?? false
    this.adminToken = config.adminToken

    const defaultAmount = config.defaultInvoiceAmount ?? 1000
    this.freeTier = config.freeTier ? new FreeTier(config.freeTier.requestsPerDay) : null

    // Wire stats collection while preserving user-provided callbacks
    const userOnPayment = config.onPayment
    const userOnRequest = config.onRequest
    const userOnChallenge = config.onChallenge
    const stats = this.stats

    // Middleware shares the same meter, invoice store, and root key
    this.middleware = tollBooth({
      ...config,
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
      _meter: this.meter,
      _invoiceStore: this.invoiceStore,
      _rootKey: this.rootKey,
      _freeTier: this.freeTier,
      trustProxy: this.trustProxy,
    })

    // Invoice status with content negotiation and HTML payment page
    this.invoiceStatusHandler = invoiceStatus({
      backend: config.backend,
      invoiceStore: this.invoiceStore,
      meter: this.meter,
      tiers: config.creditTiers,
      nwcEnabled: !!config.nwcPayInvoice,
      cashuEnabled: !!config.redeemCashu,
    })

    // Create invoice with tier support
    this.createInvoiceHandler = createInvoiceHandler({
      backend: config.backend,
      invoiceStore: this.invoiceStore,
      rootKey: this.rootKey,
      tiers: config.creditTiers ?? [],
      defaultAmount,
    })

    // NWC proxy endpoint (only if adapter provided)
    if (config.nwcPayInvoice) {
      const nwcPay = config.nwcPayInvoice
      this.nwcPayHandler = async (c: Context) => {
        try {
          const { nwcUri, bolt11 } = await c.req.json<{ nwcUri: string; bolt11: string }>()
          if (!nwcUri || !bolt11) {
            return c.json({ error: 'nwcUri and bolt11 are required' }, 400)
          }
          const preimage = await nwcPay(nwcUri, bolt11)
          stats.recordNwcPayment(defaultAmount)
          return c.json({ preimage })
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : 'NWC payment failed' }, 500)
        }
      }
    }

    // Cashu redeem endpoint (only if adapter provided)
    if (config.redeemCashu) {
      const redeem = config.redeemCashu
      const meter = this.meter
      this.cashuRedeemHandler = async (c: Context) => {
        try {
          const { token, paymentHash } = await c.req.json<{ token: string; paymentHash: string }>()
          if (!token || !paymentHash) {
            return c.json({ error: 'token and paymentHash are required' }, 400)
          }
          const credited = await redeem(token, paymentHash)
          meter.credit(paymentHash, credited)
          stats.recordCashuRedemption(credited)
          return c.json({ credited })
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : 'Cashu redemption failed' }, 500)
        }
      }
    }
  }

  /**
   * Handler for GET /stats — returns aggregate usage statistics as JSON.
   * Restricted to localhost — returns 403 for requests from other IPs.
   */
  statsHandler = async (c: Context): Promise<Response> => {
    if (!this.isAuthorisedAdmin(c)) {
      return c.json({ error: this.adminErrorMessage() }, 403)
    }
    return c.json(this.stats.snapshot())
  }

  /** Reset free-tier counters for all IPs. */
  resetFreeTier(): void {
    this.freeTier?.reset()
  }

  /**
   * Handler for POST /admin/reset-free-tier — resets free-tier counters.
   * Restricted to localhost — returns 403 for requests from other IPs.
   */
  resetFreeTierHandler = async (c: Context): Promise<Response> => {
    if (!this.isAuthorisedAdmin(c)) {
      return c.json({ error: this.adminErrorMessage() }, 403)
    }
    this.resetFreeTier()
    return c.json({ ok: true, message: 'Free-tier counters reset' })
  }

  close(): void {
    this.db.close()
  }

  private isAuthorisedAdmin(c: Context): boolean {
    if (this.adminToken) {
      const auth = c.req.header('Authorization')
      if (auth?.startsWith('Bearer ')) {
        return auth.slice(7).trim() === this.adminToken
      }
      return c.req.header('X-Admin-Token') === this.adminToken
    }

    const ip = getTrustedClientIp(c, this.trustProxy)
    return ip !== null && isLoopback(ip)
  }

  private adminErrorMessage(): string {
    if (this.adminToken) {
      return 'Invalid or missing admin token'
    }
    if (!this.trustProxy) {
      return 'Admin endpoints require adminToken or trustProxy=true with a trusted reverse proxy'
    }
    return 'Admin only available from localhost'
  }
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '::ffff:127.0.0.1'
}

function getTrustedClientIp(c: Context, trustProxy: boolean): string | null {
  if (!trustProxy) return null

  const forwardedFor = c.req.header('X-Forwarded-For')
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim()
    if (first) return first
  }

  const realIp = c.req.header('X-Real-IP')?.trim()
  return realIp || null
}
