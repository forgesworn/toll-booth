// src/adapters/express.ts
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { TollBoothEngine } from '../core/toll-booth.js'
import type { CreateInvoiceDeps } from '../core/create-invoice.js'
import type { InvoiceStatusDeps } from '../core/invoice-status.js'
import { handleCreateInvoice } from '../core/create-invoice.js'
import { handleInvoiceStatus, renderInvoiceStatusHtml } from '../core/invoice-status.js'
import { PAYMENT_HASH_RE } from '../core/types.js'

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
  const upstreamBase = config.upstream.replace(/\/$/, '')
  const extraHeaders = config.responseHeaders ?? {}

  return async (req: Request, res: Response, _next: NextFunction) => {
    const ip = config.trustProxy
      ? (typeof req.headers['x-forwarded-for'] === 'string'
          ? req.headers['x-forwarded-for'].split(',')[0]?.trim()
          : undefined) ??
        (typeof req.headers['x-real-ip'] === 'string'
          ? req.headers['x-real-ip'].trim()
          : undefined) ??
        req.socket.remoteAddress ??
        '127.0.0.1'
      : req.socket.remoteAddress ?? '127.0.0.1'

    const headers: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = Array.isArray(value) ? value.join(', ') : value
    }

    try {
      const fullPath = (req.baseUrl + req.path).replace(/\/$/, '') || '/'

      const result = await engine.handle({
        method: req.method,
        path: fullPath,
        headers,
        ip,
      })

      if (result.action === 'pass' || result.action === 'proxy') {
        // Proxy to upstream
        const target = `${upstreamBase}${req.originalUrl}`
        const fwdHeaders = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'host') continue
          const v = Array.isArray(value) ? value.join(', ') : value
          if (v) fwdHeaders.set(key, v)
        }

        const init: RequestInit & { duplex?: string } = {
          method: req.method,
          headers: fwdHeaders,
          signal: AbortSignal.timeout(30_000),
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
        // Copy response headers, skipping hop-by-hop headers we handle ourselves
        upstream_res.headers.forEach((value, key) => {
          if (key === 'transfer-encoding') return  // we buffer the body, Express sets content-length
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
        res.status(upstream_res.status).send(buf)
        return
      }

      // challenge -- 402
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value)
      }
      for (const [key, value] of Object.entries(extraHeaders)) {
        res.setHeader(key, value)
      }
      res.status(402).json(result.body)
    } catch {
      res.status(502).json({ error: 'Upstream routing engine unavailable' })
    }
  }
}

// -- Invoice status handler ---------------------------------------------------

/**
 * Returns an Express `RequestHandler` that serves invoice status as JSON or HTML.
 *
 * Expects `:paymentHash` route param. When `Accept: text/html` is requested,
 * renders the self-service payment page; otherwise returns JSON with
 * `{ paid, preimage }`.
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
    const accept = req.headers.accept ?? ''

    try {
      if (accept.includes('text/html')) {
        const { html, status } = await renderInvoiceStatusHtml(deps, paymentHash)
        res.status(status).type('html').send(html)
        return
      }

      const result = await handleInvoiceStatus(deps, paymentHash)
      res.json({ paid: result.paid, preimage: result.preimage })
    } catch {
      res.status(502).json({ error: 'Failed to check invoice status' })
    }
  }
}

// -- Create invoice handler ---------------------------------------------------

/**
 * Returns an Express `RequestHandler` that creates a new Lightning invoice.
 *
 * Assumes `express.json()` middleware is already mounted. Delegates to the
 * core `handleCreateInvoice` and returns the result.
 */
export function createExpressCreateInvoiceHandler(
  deps: CreateInvoiceDeps,
): RequestHandler {
  return async (req: Request, res: Response, _next: NextFunction) => {
    const body = req.body ?? {}
    const result = await handleCreateInvoice(deps, body)

    if (!result.success) {
      res.status(400).json({ error: result.error, tiers: result.tiers })
      return
    }

    const d = result.data!
    res.json({
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
