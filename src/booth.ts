// src/booth.ts
import type { Context } from 'hono'
import type { BoothConfig, LightningBackend } from './types.js'
import type { EventHandler } from './middleware.js'
import { tollBooth } from './middleware.js'
import { FreeTier } from './free-tier.js'
import { invoiceStatus } from './invoice-status.js'
import { createInvoiceHandler } from './create-invoice.js'
import { CreditMeter } from './meter.js'
import { InvoiceStore } from './invoice-store.js'
import { StatsCollector } from './stats.js'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import Database from 'better-sqlite3'
import { getTrustedClientIp } from './client-ip.js'

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
  private readonly backend: LightningBackend
  private readonly meter: CreditMeter
  private readonly invoiceStore: InvoiceStore
  private readonly rootKey: string
  private readonly freeTier: FreeTier | null
  private readonly trustProxy: boolean
  private readonly adminToken?: string

  constructor(config: BoothConfig & EventHandler) {
    if (!config.rootKey) {
      console.error(
        '[toll-booth] WARNING: No rootKey provided — using a random key. ' +
        'All macaroons will be invalidated on restart. ' +
        'Set rootKey to a persistent 32-byte hex string in production.',
      )
    } else if (!/^[0-9a-f]{64}$/i.test(config.rootKey)) {
      throw new Error(
        `rootKey must be exactly 64 hex characters (32 bytes), got ${config.rootKey.length} characters`,
      )
    }
    this.rootKey = config.rootKey ?? randomBytes(32).toString('hex')
    this.backend = config.backend
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
      const meter = this.meter
      const invoiceStore = this.invoiceStore
      this.nwcPayHandler = async (c: Context) => {
        try {
          const body = await c.req.json<{
            nwcUri: string; bolt11: string; paymentHash: string
          }>()
          const { nwcUri, bolt11, paymentHash } = body
          if (!nwcUri || !bolt11 || !paymentHash) {
            return c.json({ error: 'nwcUri, bolt11, and paymentHash are required' }, 400)
          }
          if (!/^[0-9a-f]{64}$/i.test(paymentHash)) {
            return c.json({ error: 'Invalid paymentHash — expected 64 hex characters' }, 400)
          }
          // Look up the server-issued invoice to get the authoritative credit amount
          const stored = invoiceStore.get(paymentHash)
          if (!stored) {
            return c.json({ error: 'Unknown payment hash — no invoice found' }, 404)
          }
          if (meter.isSettled(paymentHash)) {
            return c.json({ error: 'This payment hash has already been credited' }, 409)
          }
          if (bolt11 !== stored.bolt11) {
            return c.json({ error: 'bolt11 does not match the stored invoice' }, 400)
          }
          const preimage = await nwcPay(nwcUri, bolt11)
          // Verify preimage matches the paymentHash
          const computedHash = createHash('sha256')
            .update(Buffer.from(preimage, 'hex'))
            .digest('hex')
          if (computedHash !== paymentHash) {
            return c.json({ error: 'Preimage does not match payment hash' }, 400)
          }
          // Credit the server-determined amount, not a client-supplied value
          const wasFirstCredit = meter.creditOnce(paymentHash, stored.amountSats)
          if (!wasFirstCredit) {
            // Race: another request credited between isSettled() and here
            return c.json({ error: 'This payment hash has already been credited' }, 409)
          }
          stats.recordNwcPayment(stored.amountSats)
          return c.json({ preimage, credited: stored.amountSats })
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : 'NWC payment failed' }, 500)
        }
      }
    }

    // Cashu redeem endpoint (only if adapter provided)
    if (config.redeemCashu) {
      const redeem = config.redeemCashu
      const meter = this.meter
      const invoiceStore = this.invoiceStore
      this.cashuRedeemHandler = async (c: Context) => {
        try {
          const { token, paymentHash } = await c.req.json<{ token: string; paymentHash: string }>()
          if (!token || !paymentHash) {
            return c.json({ error: 'token and paymentHash are required' }, 400)
          }
          if (!/^[0-9a-f]{64}$/i.test(paymentHash)) {
            return c.json({ error: 'Invalid paymentHash — expected 64 hex characters' }, 400)
          }
          // Verify the paymentHash corresponds to a server-issued invoice
          const stored = invoiceStore.get(paymentHash)
          if (!stored) {
            return c.json({ error: 'Unknown payment hash — no invoice found' }, 404)
          }
          // Lock via creditOnce BEFORE consuming the token — prevents race
          // where two concurrent requests both pass isSettled() then both call redeem()
          if (meter.isSettled(paymentHash)) {
            return c.json({ error: 'This payment hash has already been credited' }, 409)
          }
          const wasFirstCredit = meter.creditOnce(paymentHash, stored.amountSats)
          if (!wasFirstCredit) {
            return c.json({ error: 'This payment hash has already been credited' }, 409)
          }

          let credited: number
          try {
            credited = await redeem(token, paymentHash)
          } catch (err) {
            // Redemption failed — roll back the settlement lock so user can retry
            meter.unsettle(paymentHash)
            throw err // Re-throw to hit the outer catch block
          }

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

  /**
   * Handler for GET /health — lightweight liveness check.
   * Returns 200 with status, uptime, and database connectivity.
   * No authentication required.
   */
  healthHandler = async (c: Context): Promise<Response> => {
    const dbOk = this.checkDatabase()
    const lnOk = await this.checkLightning()
    const allOk = dbOk && lnOk
    return c.json({
      status: allOk ? 'healthy' : 'degraded',
      upSince: this.stats.snapshot().upSince,
      database: dbOk ? 'ok' : 'unreachable',
      lightning: lnOk ? 'ok' : 'unreachable',
    }, allOk ? 200 : 503)
  }

  /**
   * Remove expired invoices and drained credits.
   * Call periodically (e.g. daily) to prevent unbounded database growth.
   * @param invoiceMaxAgeSecs - Max age for invoices (default: 86400 = 24 hours)
   */
  cleanup(invoiceMaxAgeSecs = 86_400): { invoicesRemoved: number; creditsRemoved: number } {
    const invoicesRemoved = this.invoiceStore.cleanup(invoiceMaxAgeSecs)
    const creditsRemoved = this.meter.cleanupDrained()
    return { invoicesRemoved, creditsRemoved }
  }

  close(): void {
    this.db.close()
  }

  private async checkLightning(): Promise<boolean> {
    try {
      await this.backend.checkInvoice('0'.repeat(64))
      return true
    } catch {
      return false
    }
  }

  private checkDatabase(): boolean {
    try {
      this.db.prepare('SELECT 1').get()
      return true
    } catch {
      return false
    }
  }

  private isAuthorisedAdmin(c: Context): boolean {
    if (this.adminToken) {
      const auth = c.req.header('Authorization')
      if (auth?.startsWith('Bearer ')) {
        return safeEqual(auth.slice(7).trim(), this.adminToken)
      }
      return safeEqual(c.req.header('X-Admin-Token') ?? '', this.adminToken)
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

function safeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest()
  const hashB = createHash('sha256').update(b).digest()
  return timingSafeEqual(hashA, hashB)
}
