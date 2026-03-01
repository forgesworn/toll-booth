// src/booth.ts
import type { Context } from 'hono'
import type { BoothConfig } from './types.js'
import type { EventHandler } from './middleware.js'
import { tollBooth } from './middleware.js'
import { invoiceStatus } from './invoice-status.js'
import { createInvoiceHandler } from './create-invoice.js'
import { CreditMeter } from './meter.js'
import { InvoiceStore } from './invoice-store.js'
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

  private readonly db: Database.Database
  private readonly meter: CreditMeter
  private readonly invoiceStore: InvoiceStore
  private readonly rootKey: string

  constructor(config: BoothConfig & EventHandler) {
    this.rootKey = config.rootKey ?? randomBytes(32).toString('hex')
    this.db = new Database(config.dbPath ?? ':memory:')
    this.db.pragma('journal_mode = WAL')
    this.meter = new CreditMeter(this.db)
    this.invoiceStore = new InvoiceStore(this.db)

    const defaultAmount = config.defaultInvoiceAmount ?? 1000

    // Middleware shares the same meter, invoice store, and root key
    this.middleware = tollBooth({
      ...config,
      _meter: this.meter,
      _invoiceStore: this.invoiceStore,
      _rootKey: this.rootKey,
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
          return c.json({ credited })
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : 'Cashu redemption failed' }, 500)
        }
      }
    }
  }

  close(): void {
    this.db.close()
  }
}
