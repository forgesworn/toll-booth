// src/adapters/web-standard.ts
import type { TollBoothEngine } from '../core/toll-booth.js'
import type { CreateInvoiceDeps } from '../core/create-invoice.js'
import type { InvoiceStatusDeps } from '../core/invoice-status.js'
import { handleCreateInvoice } from '../core/create-invoice.js'
import { handleInvoiceStatus, renderInvoiceStatusHtml } from '../core/invoice-status.js'

export type WebStandardHandler = (req: Request) => Promise<Response>

// -- Helpers ------------------------------------------------------------------

async function proxyUpstream(upstream: string, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const target = `${upstream}${url.pathname}${url.search}`
  const headers = new Headers(req.headers)
  headers.delete('Authorization')
  headers.delete('Host')

  const init: RequestInit & { duplex?: string } = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(30_000),
    duplex: 'half',
  }

  // Forward body for non-GET/HEAD requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body
  }

  return fetch(target, init as RequestInit)
}

// -- Middleware ----------------------------------------------------------------

/**
 * Returns a `WebStandardHandler` that enforces L402 payment gating.
 *
 * On `pass` or `proxy` results the request is forwarded to the upstream.
 * On `challenge` a 402 response is returned with invoice details.
 */
export function createWebStandardMiddleware(
  engine: TollBoothEngine,
  upstream: string,
): WebStandardHandler {
  const upstreamBase = upstream.replace(/\/$/, '')

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1'
    const headers = Object.fromEntries(req.headers.entries())

    const result = await engine.handle({
      method: req.method,
      path: url.pathname,
      headers,
      ip,
      body: req.body,
    })

    if (result.action === 'pass' || result.action === 'proxy') {
      const res = await proxyUpstream(upstreamBase, req)
      // Copy any extra headers from the engine result
      const responseHeaders = new Headers(res.headers)
      for (const [key, value] of Object.entries(result.headers)) {
        responseHeaders.set(key, value)
      }
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      })
    }

    // challenge — 402
    return Response.json(result.body, {
      status: 402,
      headers: result.headers,
    })
  }
}

// -- Invoice status handler ---------------------------------------------------

/**
 * Returns a `WebStandardHandler` that serves invoice status as JSON or HTML.
 *
 * Extracts the payment hash from the last URL path segment. When
 * `Accept: text/html` is requested, renders the self-service payment page;
 * otherwise returns JSON with `{ paid, preimage }`.
 */
export function createWebStandardInvoiceStatusHandler(
  deps: InvoiceStatusDeps,
): WebStandardHandler {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const segments = url.pathname.split('/').filter(Boolean)
    const paymentHash = segments[segments.length - 1] ?? ''
    const accept = req.headers.get('accept') ?? ''

    try {
      if (accept.includes('text/html')) {
        const { html, status } = await renderInvoiceStatusHtml(deps, paymentHash)
        return new Response(html, {
          status,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      const result = await handleInvoiceStatus(deps, paymentHash)
      return Response.json({ paid: result.paid, preimage: result.preimage })
    } catch {
      return Response.json({ error: 'Failed to check invoice status' }, { status: 502 })
    }
  }
}

// -- Create invoice handler ---------------------------------------------------

/**
 * Returns a `WebStandardHandler` that creates a new Lightning invoice.
 *
 * Parses the JSON body for an optional `amountSats` field, delegates
 * to the core `handleCreateInvoice`, and returns the result.
 */
export function createWebStandardCreateInvoiceHandler(
  deps: CreateInvoiceDeps,
): WebStandardHandler {
  return async (req: Request): Promise<Response> => {
    const body = await req.json().catch(() => ({}))
    const result = await handleCreateInvoice(deps, body)

    if (!result.success) {
      return Response.json({ error: result.error, tiers: result.tiers }, { status: 400 })
    }

    const d = result.data!
    return Response.json({
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
