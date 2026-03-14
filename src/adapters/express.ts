// src/adapters/express.ts
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { TollBoothEngine } from '../core/toll-booth.js'
import type { CreateInvoiceDeps } from '../core/create-invoice.js'
import type { InvoiceStatusDeps } from '../core/invoice-status.js'
import { handleCreateInvoice } from '../core/create-invoice.js'
import { handleInvoiceStatus, renderInvoiceStatusHtml } from '../core/invoice-status.js'
import { handleNwcPay } from '../core/nwc-pay.js'
import type { NwcPayDeps } from '../core/nwc-pay.js'
import { handleCashuRedeem } from '../core/cashu-redeem.js'
import type { CashuRedeemDeps } from '../core/cashu-redeem.js'
import { PAYMENT_HASH_RE } from '../core/types.js'
import {
  appendVary,
  applyNoStoreHeaders,
  applySecurityHeaders,
  parseForwardedIp,
  stripProxyRequestHeaders,
  stripProxyResponseHeaders,
} from './proxy-headers.js'

const MAX_BODY_BYTES = 65_536

/**
 * Reject requests with Content-Length exceeding the body size limit.
 * Defence-in-depth fast-reject via header; does not guard chunked requests.
 * The consumer MUST configure express.json({ limit: '64kb' }) for full enforcement.
 */
function rejectOversizedBody(req: Request, res: Response): boolean {
  const cl = req.headers['content-length']
  if (cl !== undefined) {
    const len = parseInt(cl as string, 10)
    if (!Number.isFinite(len) || len > MAX_BODY_BYTES) {
      res.status(413).json({ error: 'Request body too large' })
      return true
    }
  }
  return false
}

// -- Middleware ---------------------------------------------------------------

/**
 * Returns an Express `RequestHandler` that enforces L402 payment gating.
 *
 * On `pass` or `proxy` results the request is forwarded to the upstream.
 * On `challenge` a 402 response is returned with invoice details.
 */
export interface ExpressMiddlewareConfig {
  engine: TollBoothEngine
  upstream: string
  trustProxy?: boolean
  responseHeaders?: Record<string, string>
  /** Timeout in milliseconds for upstream proxy requests (default: 30000). */
  upstreamTimeout?: number
  /**
   * Custom callback to extract client IP from the request.
   * Use this for platform-specific IP resolution.
   * Takes precedence over trustProxy when provided.
   */
  getClientIp?: (req: Request) => string
}

function setSensitiveHeaders(res: Response, headers?: Headers): void {
  const merged = headers ? new Headers(headers) : new Headers()
  applyNoStoreHeaders(merged)
  merged.forEach((value, key) => {
    res.setHeader(key, value)
  })
}

function jsonWithSensitiveHeaders(
  res: Response,
  body: unknown,
  status = 200,
  headers?: Headers,
): void {
  setSensitiveHeaders(res, headers)
  res.status(status).json(body)
}

function htmlWithSensitiveHeaders(
  res: Response,
  html: string,
  status = 200,
  headers?: Headers,
): void {
  setSensitiveHeaders(res, headers)
  res.status(status).type('html').send(html)
}

function buildUpstreamTarget(upstreamBase: string, originalUrl: string): string {
  const incoming = new URL(originalUrl, 'http://localhost')
  const upstream = new URL(upstreamBase)
  const upstreamPath = upstream.pathname.endsWith('/')
    ? upstream.pathname.slice(0, -1)
    : upstream.pathname
  const incomingPath = incoming.pathname.startsWith('/')
    ? incoming.pathname
    : `/${incoming.pathname}`

  upstream.pathname = `${upstreamPath}${incomingPath}` || '/'
  upstream.search = incoming.search
  return upstream.href
}

export function createExpressMiddleware(
  engineOrConfig: TollBoothEngine | ExpressMiddlewareConfig,
  upstreamArg?: string,
): RequestHandler {
  // Support both old (engine, upstream) and new (config) signatures
  const config: ExpressMiddlewareConfig = typeof upstreamArg === 'string'
    ? { engine: engineOrConfig as TollBoothEngine, upstream: upstreamArg }
    : engineOrConfig as ExpressMiddlewareConfig
  const engine = config.engine

  // Warn when free-tier is enabled without trustProxy (P3) — all requests
  // will share a single socket.remoteAddress behind a reverse proxy.
  if (engine.freeTier && !config.trustProxy) {
    console.error(
      '[toll-booth] WARNING: freeTier enabled without trustProxy in Express adapter. ' +
      'Behind a reverse proxy all clients will share one IP bucket. ' +
      'Set trustProxy: true or provide a getClientIp callback.',
    )
  }

  const upstreamBase = config.upstream.replace(/\/$/, '')
  const extraHeaders = config.responseHeaders ?? {}
  const upstreamTimeout = config.upstreamTimeout ?? 30_000

  return async (req: Request, res: Response, _next: NextFunction) => {
    const ip = config.getClientIp
      ? config.getClientIp(req)
      : config.trustProxy
        ? parseForwardedIp(typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : undefined) ??
          parseForwardedIp(typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : undefined) ??
          req.socket.remoteAddress ??
          '127.0.0.1'
        : req.socket.remoteAddress ?? '127.0.0.1'

    const headers: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = Array.isArray(value) ? value.join(', ') : value
    }

    try {
      const fullPath = (req.baseUrl + req.path).replace(/\/$/, '') || '/'

      const rawTier = req.query.tier
      const tier = (Array.isArray(rawTier) ? rawTier[0] : rawTier) as string | undefined
        ?? (typeof req.headers['x-toll-tier'] === 'string' ? req.headers['x-toll-tier'] : undefined)

      const result = await engine.handle({
        method: req.method,
        path: fullPath,
        headers,
        ip,
        tier,
      })

      if (result.action === 'pass' || result.action === 'proxy') {
        // Proxy to upstream
        const target = buildUpstreamTarget(upstreamBase, req.originalUrl)
        const incomingHeaders = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          const v = Array.isArray(value) ? value.join(', ') : value
          if (v) incomingHeaders.set(key, v)
        }
        const fwdHeaders = stripProxyRequestHeaders(incomingHeaders)

        const init: RequestInit & { duplex?: string } = {
          method: req.method,
          headers: fwdHeaders,
          signal: AbortSignal.timeout(upstreamTimeout),
          duplex: 'half',
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          // If body-parsing middleware already consumed the stream, re-serialise
          if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
            const json = JSON.stringify(req.body)
            init.body = json
            fwdHeaders.set('content-length', Buffer.byteLength(json).toString())
          } else {
            init.body = req as unknown as ReadableStream
          }
        }

        const upstream_res = await fetch(target, init as RequestInit)
        const responseHeaders = stripProxyResponseHeaders(upstream_res.headers)
        responseHeaders.forEach((value, key) => {
          res.setHeader(key, value)
        })
        // Set extra headers from engine result
        for (const [key, value] of Object.entries(result.headers)) {
          res.setHeader(key, value)
        }
        for (const [key, value] of Object.entries(extraHeaders)) {
          res.setHeader(key, value)
        }
        const buf = Buffer.from(await upstream_res.arrayBuffer())

        // Reconcile estimated cost against actual cost reported by the upstream.
        // Only applies to L402-authenticated requests (result has paymentHash).
        if (result.action === 'proxy' && result.paymentHash) {
          const tollCostHeader = upstream_res.headers.get('x-toll-cost')
          if (tollCostHeader !== null && /^\d+$/.test(tollCostHeader)) {
            const actualCost = parseInt(tollCostHeader, 10)
            if (Number.isSafeInteger(actualCost) && actualCost >= 0) {
              const reconciled = engine.reconcile(result.paymentHash, actualCost)
              if (reconciled.adjusted) {
                res.setHeader('X-Credit-Balance', String(reconciled.newBalance))
              }
            } else {
              console.warn('[toll-booth] Invalid X-Toll-Cost value:', tollCostHeader?.slice(0, 32))
            }
          }
        }

        res.status(upstream_res.status).send(buf)
        return
      }

      // challenge -- 402
      const challengeHeaders = new Headers()
      for (const [key, value] of Object.entries(result.headers)) {
        challengeHeaders.set(key, value)
      }
      for (const [key, value] of Object.entries(extraHeaders)) {
        challengeHeaders.set(key, value)
      }
      jsonWithSensitiveHeaders(res, result.body, 402, challengeHeaders)
    } catch (err) {
      // Distinguish upstream network errors from programming errors
      if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('network'))) {
        res.status(502).json({ error: 'Upstream unavailable' })
      } else if (err instanceof DOMException && err.name === 'TimeoutError') {
        res.status(504).json({ error: 'Upstream timeout' })
      } else if (err instanceof DOMException && err.name === 'AbortError') {
        res.status(504).json({ error: 'Upstream request aborted' })
      } else {
        console.error('[toll-booth] Unexpected error in middleware:', err instanceof Error ? err.message : err)
        res.status(502).json({ error: 'Upstream unavailable' })
      }
    }
  }
}

// -- Invoice status handler ---------------------------------------------------

/**
 * Returns an Express `RequestHandler` that serves invoice status as JSON or HTML.
 *
 * Expects `:paymentHash` route param plus a `?token=...` status lookup secret.
 * When `Accept: text/html` is requested, renders the self-service payment page;
 * otherwise returns JSON with `{ paid, preimage }`.
 */
export function createExpressInvoiceStatusHandler(
  deps: InvoiceStatusDeps,
): RequestHandler {
  return async (req: Request, res: Response, _next: NextFunction) => {
    const paymentHash = Array.isArray(req.params.paymentHash)
      ? req.params.paymentHash[0]
      : req.params.paymentHash
    if (!PAYMENT_HASH_RE.test(paymentHash)) {
      res.status(400).json({ error: 'Invalid payment hash' })
      return
    }
    const rawToken = typeof req.query.token === 'string' ? req.query.token : undefined
    const statusToken = rawToken && rawToken.length <= 128 ? rawToken : undefined
    const accept = req.headers.accept ?? ''

    try {
      if (accept.includes('text/html')) {
        const { html, status } = await renderInvoiceStatusHtml(deps, paymentHash, statusToken)
        htmlWithSensitiveHeaders(res, html, status, appendVary(applySecurityHeaders(new Headers()), 'Accept'))
        return
      }

      const result = await handleInvoiceStatus(deps, paymentHash, statusToken)
      if (!result.found) {
        jsonWithSensitiveHeaders(
          res,
          { error: 'Invoice not found' },
          404,
          appendVary(new Headers(), 'Accept'),
        )
        return
      }
      jsonWithSensitiveHeaders(
        res,
        { paid: result.paid, preimage: result.preimage, token_suffix: result.tokenSuffix },
        200,
        appendVary(new Headers(), 'Accept'),
      )
    } catch {
      jsonWithSensitiveHeaders(
        res,
        { error: 'Failed to check invoice status' },
        502,
        appendVary(new Headers(), 'Accept'),
      )
    }
  }
}

// -- Create invoice handler ---------------------------------------------------

export interface CreateInvoiceHandlerConfig {
  deps: CreateInvoiceDeps
  trustProxy?: boolean
}

/**
 * Returns an Express `RequestHandler` that creates a new Lightning invoice.
 *
 * Assumes `express.json()` middleware is already mounted. Delegates to the
 * core `handleCreateInvoice` and returns the result.
 *
 * Accepts either a bare `CreateInvoiceDeps` object (backwards-compatible) or
 * a `CreateInvoiceHandlerConfig` for IP-aware rate limiting.
 */
export function createExpressCreateInvoiceHandler(
  depsOrConfig: CreateInvoiceDeps | CreateInvoiceHandlerConfig,
): RequestHandler {
  const config = 'deps' in depsOrConfig ? depsOrConfig : { deps: depsOrConfig }
  const deps = config.deps

  return async (req: Request, res: Response, _next: NextFunction) => {
    if (rejectOversizedBody(req, res)) return
    const body = req.body ?? {}
    const ip = config.trustProxy
      ? parseForwardedIp(typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : undefined) ??
        parseForwardedIp(typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : undefined) ??
        req.socket.remoteAddress ?? '127.0.0.1'
      : req.socket.remoteAddress ?? '127.0.0.1'

    const result = await handleCreateInvoice(deps, { ...body, clientIp: ip })

    if (!result.success) {
      jsonWithSensitiveHeaders(res, { error: result.error, tiers: result.tiers }, result.status ?? 400)
      return
    }

    const d = result.data!
    jsonWithSensitiveHeaders(res, {
      bolt11: d.bolt11,
      payment_hash: d.paymentHash,
      payment_url: d.paymentUrl,
      amount_sats: d.amountSats,
      credit_sats: d.creditSats,
      macaroon: d.macaroon,
      qr_svg: d.qrSvg,
    })
  }
}

// -- NWC handler --------------------------------------------------------------

/**
 * Returns an Express `RequestHandler` that pays a Lightning invoice via NWC.
 *
 * Expects JSON body with `{ nwcUri, bolt11, paymentHash, statusToken }`.
 * Returns the payment preimage on success.
 */
export function createExpressNwcHandler(deps: NwcPayDeps): RequestHandler {
  return async (req: Request, res: Response, _next: NextFunction) => {
    if (rejectOversizedBody(req, res)) return
    const body = req.body ?? {}
    const result = await handleNwcPay(deps, body)
    if (result.success) {
      jsonWithSensitiveHeaders(res, { preimage: result.preimage })
    } else {
      jsonWithSensitiveHeaders(res, { error: result.error }, result.status)
    }
  }
}

// -- Cashu handler ------------------------------------------------------------

/**
 * Returns an Express `RequestHandler` that redeems a Cashu token as payment.
 *
 * Expects JSON body with `{ token, paymentHash, statusToken }`.
 * Uses durable claims and leases to avoid concurrent duplicate redemption.
 */
export function createExpressCashuHandler(deps: CashuRedeemDeps): RequestHandler {
  return async (req: Request, res: Response, _next: NextFunction) => {
    if (rejectOversizedBody(req, res)) return
    const body = req.body ?? {}
    const result = await handleCashuRedeem(deps, body)
    if (result.success) {
      jsonWithSensitiveHeaders(res, { credited: result.credited, token_suffix: result.tokenSuffix })
    } else if ('state' in result) {
      jsonWithSensitiveHeaders(res, { state: result.state, retryAfterMs: result.retryAfterMs }, 202)
    } else {
      jsonWithSensitiveHeaders(res, { error: result.error }, result.status)
    }
  }
}
