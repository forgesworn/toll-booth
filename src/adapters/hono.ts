// src/adapters/hono.ts
import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import type { TollBoothEngine } from '../core/toll-booth.js'
import type { TollBoothRequest, CreateInvoiceRequest, NwcPayRequest, CashuRedeemRequest } from '../core/types.js'
import { PAYMENT_HASH_RE } from '../core/types.js'
import type { LightningBackend, CreditTier } from '../types.js'
import type { StorageBackend } from '../storage/interface.js'
import { handleCreateInvoice } from '../core/create-invoice.js'
import type { CreateInvoiceDeps } from '../core/create-invoice.js'
import { handleInvoiceStatus, renderInvoiceStatusHtml } from '../core/invoice-status.js'
import type { InvoiceStatusDeps } from '../core/invoice-status.js'
import { handleNwcPay } from '../core/nwc-pay.js'
import type { NwcPayDeps } from '../core/nwc-pay.js'
import { handleCashuRedeem } from '../core/cashu-redeem.js'
import type { CashuRedeemDeps } from '../core/cashu-redeem.js'
import { applyNoStoreHeaders, appendVary } from './proxy-headers.js'

const MAX_BODY_BYTES = 65_536

/**
 * Parses request body as JSON with a size limit.
 * Returns undefined on oversized, empty, or malformed bodies.
 */
async function safeParseJson<T>(c: Context, maxBytes = MAX_BODY_BYTES): Promise<T | undefined> {
  const contentLength = c.req.header('content-length')
  if (contentLength !== undefined) {
    const len = parseInt(contentLength, 10)
    if (!Number.isFinite(len) || len < 0 || len > maxBytes) return undefined
  }
  try {
    const text = await c.req.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) return undefined
    if (!text.trim()) return {} as T
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/**
 * Hono context variables set by the toll-booth auth middleware.
 *
 * Consumers should declare `Hono<TollBoothEnv>` to get typed access
 * to these variables via `c.get()`.
 */
export type TollBoothEnv = {
  Variables: {
    tollBoothAction: 'proxy' | 'pass'
    tollBoothPaymentHash: string | undefined
    tollBoothEstimatedCost: number | undefined
    tollBoothCreditBalance: number | undefined
    tollBoothFreeRemaining: number | undefined
  }
}

export interface HonoTollBoothConfig {
  engine: TollBoothEngine
  /**
   * Custom callback to extract client IP from the Hono context.
   * Use this for platform-specific IP resolution (e.g. Cloudflare's
   * `CF-Connecting-IP`, or `X-Real-IP` behind a trusted reverse proxy).
   * Falls back to `X-Forwarded-For` header if not provided.
   */
  getClientIp?: (c: Context) => string
}

export interface PaymentAppConfig {
  storage: StorageBackend
  rootKey: string
  tiers: CreditTier[]
  defaultAmount: number
  backend?: LightningBackend
  maxPendingPerIp?: number
  nwcPay?: NwcPayDeps['nwcPay']
  cashuRedeem?: CashuRedeemDeps['redeem']
  getClientIp?: (c: Context) => string
}

export interface HonoTollBooth {
  authMiddleware: MiddlewareHandler<TollBoothEnv>
  engine: TollBoothEngine
  createPaymentApp: (paymentConfig: PaymentAppConfig) => Hono
}

/**
 * Creates a Hono middleware that enforces L402 payment gating.
 *
 * On `challenge` results a 402 response is returned with invoice details.
 * On `pass` or `proxy` results, context variables are set and the next
 * handler is called:
 * - `tollBoothAction`: `'proxy'` or `'pass'`
 * - `tollBoothPaymentHash`: payment hash (proxy only)
 * - `tollBoothEstimatedCost`: estimated cost in credits (proxy only)
 * - `tollBoothCreditBalance`: remaining balance (proxy only)
 * - `tollBoothFreeRemaining`: remaining free-tier requests (proxy only)
 */
export function createHonoTollBooth(config: HonoTollBoothConfig): HonoTollBooth {
  const { engine } = config

  const authMiddleware: MiddlewareHandler<TollBoothEnv> = async (c, next) => {
    const req = c.req.raw
    const ip = config.getClientIp?.(c)
      ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      ?? '0.0.0.0'

    const tollReq: TollBoothRequest = {
      method: req.method,
      path: new URL(req.url).pathname,
      headers: Object.fromEntries(req.headers.entries()),
      ip,
      body: req.body,
    }

    const result = await engine.handle(tollReq)

    if (result.action === 'challenge') {
      c.header('Cache-Control', 'no-store')
      c.header('Pragma', 'no-cache')
      c.header('X-Content-Type-Options', 'nosniff')
      return c.json(result.body, result.status as 402, result.headers)
    }

    // 'proxy' or 'pass' — set context variables and continue
    if (result.action === 'proxy') {
      c.set('tollBoothPaymentHash', result.paymentHash)
      c.set('tollBoothEstimatedCost', result.estimatedCost)
      c.set('tollBoothCreditBalance', result.creditBalance)
      c.set('tollBoothFreeRemaining', result.freeRemaining)
    }
    c.set('tollBoothAction', result.action)

    await next()
  }

  function createPaymentApp(paymentConfig: PaymentAppConfig): Hono {
    const app = new Hono()

    const createInvoiceDeps: CreateInvoiceDeps = {
      backend: paymentConfig.backend,
      storage: paymentConfig.storage,
      rootKey: paymentConfig.rootKey,
      tiers: paymentConfig.tiers,
      defaultAmount: paymentConfig.defaultAmount,
      maxPendingPerIp: paymentConfig.maxPendingPerIp,
    }

    const invoiceStatusDeps: InvoiceStatusDeps = {
      backend: paymentConfig.backend,
      storage: paymentConfig.storage,
      tiers: paymentConfig.tiers,
      nwcEnabled: paymentConfig.nwcPay !== undefined,
      cashuEnabled: paymentConfig.cashuRedeem !== undefined,
    }

    const noStore = (c: Context) => {
      c.header('Cache-Control', 'no-store')
      c.header('Pragma', 'no-cache')
      c.header('X-Content-Type-Options', 'nosniff')
    }

    // POST /create-invoice
    app.post('/create-invoice', async (c) => {
      const ip = paymentConfig.getClientIp?.(c)
        ?? config.getClientIp?.(c)
        ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
        ?? '0.0.0.0'

      const body = await safeParseJson<CreateInvoiceRequest>(c)
      if (body === undefined) {
        noStore(c)
        return c.json({ error: 'Invalid JSON body' }, 400)
      }

      const result = await handleCreateInvoice(createInvoiceDeps, { ...body, clientIp: ip })

      noStore(c)
      if (!result.success) {
        return c.json({ error: result.error, tiers: result.tiers }, (result.status ?? 400) as 400)
      }

      const d = result.data!
      return c.json({
        bolt11: d.bolt11,
        payment_hash: d.paymentHash,
        payment_url: d.paymentUrl,
        amount_sats: d.amountSats,
        credit_sats: d.creditSats,
        macaroon: d.macaroon,
        qr_svg: d.qrSvg,
      })
    })

    // GET /invoice-status/:paymentHash
    app.get('/invoice-status/:paymentHash', async (c) => {
      const paymentHash = c.req.param('paymentHash')
      if (!PAYMENT_HASH_RE.test(paymentHash)) {
        return c.json({ error: 'Invalid payment hash' }, 400)
      }
      const token = c.req.query('token')
      const statusToken = token && token.length <= 128 ? token : undefined
      const accept = c.req.header('accept') ?? ''

      try {
        if (accept.includes('text/html')) {
          const { html, status } = await renderInvoiceStatusHtml(invoiceStatusDeps, paymentHash, statusToken)
          const headers = appendVary(applyNoStoreHeaders(new Headers()), 'Accept')
          headers.set('Content-Type', 'text/html; charset=utf-8')
          return new Response(html, { status, headers })
        }

        const result = await handleInvoiceStatus(invoiceStatusDeps, paymentHash, statusToken)
        if (!result.found) {
          return c.json({ error: 'Invoice not found' }, 404)
        }
        c.header('Cache-Control', 'no-store')
        c.header('Pragma', 'no-cache')
        c.header('X-Content-Type-Options', 'nosniff')
        c.header('Vary', 'Accept')
        return c.json({ paid: result.paid, preimage: result.preimage, token_suffix: result.tokenSuffix })
      } catch {
        return c.json({ error: 'Failed to check invoice status' }, 502)
      }
    })

    // POST /nwc-pay (optional)
    if (paymentConfig.nwcPay) {
      const nwcDeps: NwcPayDeps = {
        nwcPay: paymentConfig.nwcPay,
        storage: paymentConfig.storage,
      }

      app.post('/nwc-pay', async (c) => {
        const body = await safeParseJson<NwcPayRequest>(c)
        if (body === undefined) {
          noStore(c)
          return c.json({ error: 'Invalid JSON body' }, 400)
        }

        const result = await handleNwcPay(nwcDeps, body)
        noStore(c)
        if (result.success) {
          return c.json({ preimage: result.preimage })
        }
        return c.json({ error: result.error }, result.status as 400 | 500)
      })
    }

    // POST /cashu-redeem (optional)
    if (paymentConfig.cashuRedeem) {
      const cashuDeps: CashuRedeemDeps = {
        redeem: paymentConfig.cashuRedeem,
        storage: paymentConfig.storage,
      }

      app.post('/cashu-redeem', async (c) => {
        const body = await safeParseJson<CashuRedeemRequest>(c)
        if (body === undefined) {
          noStore(c)
          return c.json({ error: 'Invalid JSON body' }, 400)
        }

        const result = await handleCashuRedeem(cashuDeps, body)
        noStore(c)
        if (result.success) {
          return c.json({ credited: result.credited, token_suffix: result.tokenSuffix })
        }
        if ('state' in result) {
          return c.json({ state: result.state, retryAfterMs: result.retryAfterMs }, 202)
        }
        return c.json({ error: result.error }, result.status as 400 | 500)
      })
    }

    return app
  }

  return { authMiddleware, engine, createPaymentApp }
}
