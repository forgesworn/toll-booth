// src/adapters/web-standard.ts
import type { TollBoothEngine } from '../core/toll-booth.js'
import type { CreateInvoiceDeps } from '../core/create-invoice.js'
import type { CreateInvoiceRequest, NwcPayRequest, CashuRedeemRequest } from '../core/types.js'
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
  stripProxyRequestHeaders,
  stripProxyResponseHeaders,
} from './proxy-headers.js'

export type WebStandardHandler = (req: Request) => Promise<Response>

// -- Helpers ------------------------------------------------------------------

class BodyTooLargeError extends Error {}
type ParsedJson<T> = { ok: true; value: T } | { ok: false }

/**
 * Parses the request body as JSON with a configurable size limit.
 *
 * Checks the `Content-Length` header first for a fast rejection, then reads
 * the body as text and enforces the byte limit before parsing. Returns an
 * empty object on any failure (oversized body, missing body, malformed JSON)
 * so callers behave identically to the previous `.catch(() => ({}))` pattern.
 *
 * @param req      - The incoming request.
 * @param maxBytes - Maximum allowed body size in bytes (default: 64 KiB).
 */
async function safeParseJson<T = Record<string, unknown>>(req: Request, maxBytes = 65_536): Promise<ParsedJson<T>> {
  // Quick rejection via Content-Length header — avoids reading the body at all
  const contentLength = req.headers.get('content-length')
  if (contentLength !== null) {
    const parsedLength = parseInt(contentLength, 10)
    if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      return { ok: false }
    }
  }

  try {
    const text = await readBodyTextWithinLimit(req, maxBytes)
    if (!text.trim()) return { ok: true, value: {} as T }
    return { ok: true, value: JSON.parse(text) as T }
  } catch {
    return { ok: false }
  }
}

async function proxyUpstream(upstream: string, req: Request, timeoutMs = 30_000): Promise<Response> {
  const url = new URL(req.url)
  const target = `${upstream}${url.pathname}${url.search}`
  const headers = stripProxyRequestHeaders(req.headers)

  const init: RequestInit & { duplex?: string } = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    duplex: 'half',
  }

  // Forward body for non-GET/HEAD requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body
  }

  return fetch(target, init as RequestInit)
}

async function readBodyTextWithinLimit(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return ''

  const reader = req.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let text = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new BodyTooLargeError('Request body exceeded limit')
      }

      text += decoder.decode(value, { stream: true })
    }

    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

// -- Middleware ----------------------------------------------------------------

/**
 * Returns a `WebStandardHandler` that enforces L402 payment gating.
 *
 * On `pass` or `proxy` results the request is forwarded to the upstream.
 * On `challenge` a 402 response is returned with invoice details.
 */
export interface WebStandardMiddlewareConfig {
  engine: TollBoothEngine
  upstream: string
  trustProxy?: boolean
  responseHeaders?: Record<string, string>
  /** Timeout in milliseconds for upstream proxy requests (default: 30000). */
  upstreamTimeout?: number
  /**
   * Custom callback to extract client IP from the request.
   * Use this for platform-specific IP resolution (e.g. Cloudflare's
   * `CF-Connecting-IP`, Deno's `connInfo.remoteAddr`).
   * If `freeTier` is enabled, provide either `trustProxy: true` or
   * a `getClientIp` callback for per-client isolation.
   */
  getClientIp?: (req: Request) => string
}

export function createWebStandardMiddleware(
  engineOrConfig: TollBoothEngine | WebStandardMiddlewareConfig,
  upstreamArg?: string,
): WebStandardHandler {
  // Support both old (engine, upstream) and new (config) signatures
  const config: WebStandardMiddlewareConfig = typeof upstreamArg === 'string'
    ? { engine: engineOrConfig as TollBoothEngine, upstream: upstreamArg }
    : engineOrConfig as WebStandardMiddlewareConfig
  const engine = config.engine
  const upstreamBase = config.upstream.replace(/\/$/, '')
  const extraHeaders = config.responseHeaders ?? {}
  const upstreamTimeout = config.upstreamTimeout ?? 30_000

  // Fail closed when free-tier is enabled but all requests would collapse
  // into one shared bucket.
  if (engine.freeTier && !config.trustProxy && !config.getClientIp) {
    throw new Error(
      'freeTier requires either trustProxy: true or getClientIp for the web-standard adapter',
    )
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const ip = config.getClientIp
      ? config.getClientIp(req)
      : config.trustProxy
        ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? 'unknown'
        : 'unknown'
    const headers = Object.fromEntries(req.headers.entries())

    const result = await engine.handle({
      method: req.method,
      path: url.pathname,
      headers,
      ip,
      body: req.body,
      tier: url.searchParams.get('tier') ?? req.headers.get('x-toll-tier') ?? undefined,
    })

    if (result.action === 'pass' || result.action === 'proxy') {
      try {
        const res = await proxyUpstream(upstreamBase, req, upstreamTimeout)
        const responseHeaders = stripProxyResponseHeaders(res.headers)
        for (const [key, value] of Object.entries(result.headers)) {
          responseHeaders.set(key, value)
        }
        for (const [key, value] of Object.entries(extraHeaders)) {
          responseHeaders.set(key, value)
        }
        // Reconcile estimated cost against actual cost reported by the upstream
        if (result.action === 'proxy' && result.paymentHash) {
          const tollCostHeader = res.headers.get('x-toll-cost')
          if (tollCostHeader !== null && /^\d+$/.test(tollCostHeader)) {
            const actualCost = parseInt(tollCostHeader, 10)
            if (Number.isSafeInteger(actualCost) && actualCost >= 0) {
              const reconciled = engine.reconcile(result.paymentHash, actualCost)
              if (reconciled.adjusted) {
                responseHeaders.set('X-Credit-Balance', String(reconciled.newBalance))
              }
            } else {
              console.warn('[toll-booth] Invalid X-Toll-Cost value:', tollCostHeader?.slice(0, 32))
            }
          }
        }
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
        })
      } catch (err) {
        // Distinguish upstream network errors from timeouts
        if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          return Response.json(
            { error: 'Upstream timeout' },
            { status: 504, headers: new Headers(extraHeaders) },
          )
        }
        if (!(err instanceof TypeError)) {
          console.error('[toll-booth] Unexpected error in middleware:', err instanceof Error ? err.message : err)
        }
        return Response.json(
          { error: 'Upstream unavailable' },
          { status: 502, headers: new Headers(extraHeaders) },
        )
      }
    }

    // challenge — 402
    const challengeHeaders = new Headers(extraHeaders)
    for (const [key, value] of Object.entries(result.headers)) {
      challengeHeaders.set(key, value)
    }
    applyNoStoreHeaders(challengeHeaders)
    return Response.json(result.body, {
      status: 402,
      headers: challengeHeaders,
    })
  }
}

// -- Invoice status handler ---------------------------------------------------

/**
 * Returns a `WebStandardHandler` that serves invoice status as JSON or HTML.
 *
 * Extracts the payment hash from the last URL path segment and expects
 * a `?token=...` status lookup secret. When `Accept: text/html` is requested,
 * renders the self-service payment page; otherwise returns JSON with
 * `{ paid, preimage }`.
 */
export function createWebStandardInvoiceStatusHandler(
  deps: InvoiceStatusDeps,
): WebStandardHandler {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const segments = url.pathname.split('/').filter(Boolean)
    const paymentHash = segments[segments.length - 1] ?? ''
    if (!PAYMENT_HASH_RE.test(paymentHash)) {
      return Response.json({ error: 'Invalid payment hash' }, { status: 400 })
    }
    const rawToken = url.searchParams.get('token') ?? undefined
    const statusToken = rawToken && rawToken.length <= 128 ? rawToken : undefined
    const accept = req.headers.get('accept') ?? ''

    try {
      if (accept.includes('text/html')) {
        const { html, status } = await renderInvoiceStatusHtml(deps, paymentHash, statusToken)
        const headers = appendVary(applyNoStoreHeaders(new Headers()), 'Accept')
        headers.set('Content-Type', 'text/html; charset=utf-8')
        return new Response(html, {
          status,
          headers,
        })
      }

      const result = await handleInvoiceStatus(deps, paymentHash, statusToken)
      if (!result.found) {
        return Response.json(
          { error: 'Invoice not found' },
          { status: 404, headers: appendVary(applyNoStoreHeaders(new Headers()), 'Accept') },
        )
      }
      return Response.json(
        { paid: result.paid, preimage: result.preimage, token_suffix: result.tokenSuffix },
        { headers: appendVary(applyNoStoreHeaders(new Headers()), 'Accept') },
      )
    } catch {
      return Response.json(
        { error: 'Failed to check invoice status' },
        { status: 502, headers: appendVary(applyNoStoreHeaders(new Headers()), 'Accept') },
      )
    }
  }
}

// -- Create invoice handler ---------------------------------------------------

export interface WebStandardCreateInvoiceConfig {
  deps: CreateInvoiceDeps
  trustProxy?: boolean
  getClientIp?: (req: Request) => string
}

/**
 * Returns a `WebStandardHandler` that creates a new Lightning invoice.
 *
 * Parses the JSON body for an optional `amountSats` field, delegates
 * to the core `handleCreateInvoice`, and returns the result.
 *
 * Accepts either a bare `CreateInvoiceDeps` object (backwards-compatible) or
 * a `WebStandardCreateInvoiceConfig` for IP-aware rate limiting.
 */
export function createWebStandardCreateInvoiceHandler(
  depsOrConfig: CreateInvoiceDeps | WebStandardCreateInvoiceConfig,
): WebStandardHandler {
  const config = 'deps' in depsOrConfig ? depsOrConfig : { deps: depsOrConfig }
  const deps = config.deps

  return async (req: Request): Promise<Response> => {
    const parsed = await safeParseJson<CreateInvoiceRequest>(req)
    if (!parsed.ok) {
      return Response.json(
        { error: 'Invalid JSON body' },
        { status: 400, headers: applyNoStoreHeaders(new Headers()) },
      )
    }

    const ip = config.getClientIp
      ? config.getClientIp(req)
      : config.trustProxy
        ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? 'unknown'
        : 'unknown'

    const result = await handleCreateInvoice(deps, { ...parsed.value, clientIp: ip })

    if (!result.success) {
      return Response.json(
        { error: result.error, tiers: result.tiers },
        { status: result.status ?? 400, headers: applyNoStoreHeaders(new Headers()) },
      )
    }

    const d = result.data!
    return Response.json(
      {
        bolt11: d.bolt11,
        payment_hash: d.paymentHash,
        payment_url: d.paymentUrl,
        amount_sats: d.amountSats,
        credit_sats: d.creditSats,
        macaroon: d.macaroon,
        qr_svg: d.qrSvg,
      },
      { headers: applyNoStoreHeaders(new Headers()) },
    )
  }
}

// -- NWC handler --------------------------------------------------------------

/**
 * Returns a `WebStandardHandler` that pays a Lightning invoice via NWC.
 *
 * Expects JSON body with `{ nwcUri, bolt11, paymentHash, statusToken }`.
 * Returns the payment preimage on success.
 */
export function createWebStandardNwcHandler(deps: NwcPayDeps): WebStandardHandler {
  return async (req: Request): Promise<Response> => {
    const parsed = await safeParseJson<NwcPayRequest>(req)
    if (!parsed.ok) {
      return Response.json(
        { error: 'Invalid JSON body' },
        { status: 400, headers: applyNoStoreHeaders(new Headers()) },
      )
    }

    const result = await handleNwcPay(deps, parsed.value)
    if (result.success) {
      return Response.json({ preimage: result.preimage }, { headers: applyNoStoreHeaders(new Headers()) })
    }
    return Response.json(
      { error: result.error },
      { status: result.status, headers: applyNoStoreHeaders(new Headers()) },
    )
  }
}

// -- Cashu handler ------------------------------------------------------------

/**
 * Returns a `WebStandardHandler` that redeems a Cashu token as payment.
 *
 * Expects JSON body with `{ token, paymentHash, statusToken }`.
 * Uses durable claims and leases to avoid concurrent duplicate redemption.
 */
export function createWebStandardCashuHandler(deps: CashuRedeemDeps): WebStandardHandler {
  return async (req: Request): Promise<Response> => {
    const parsed = await safeParseJson<CashuRedeemRequest>(req)
    if (!parsed.ok) {
      return Response.json(
        { error: 'Invalid JSON body' },
        { status: 400, headers: applyNoStoreHeaders(new Headers()) },
      )
    }

    const result = await handleCashuRedeem(deps, parsed.value)
    if (result.success) {
      return Response.json(
        { credited: result.credited, token_suffix: result.tokenSuffix },
        { headers: applyNoStoreHeaders(new Headers()) },
      )
    }
    if ('state' in result) {
      return Response.json(
        { state: result.state, retryAfterMs: result.retryAfterMs },
        { status: 202, headers: applyNoStoreHeaders(new Headers()) },
      )
    }
    return Response.json(
      { error: result.error },
      { status: result.status, headers: applyNoStoreHeaders(new Headers()) },
    )
  }
}
