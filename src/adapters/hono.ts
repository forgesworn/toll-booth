// src/adapters/hono.ts
import type { Context, MiddlewareHandler } from 'hono'
import type { TollBoothEngine } from '../core/toll-booth.js'
import type { CreateInvoiceDeps } from '../core/create-invoice.js'
import type { InvoiceStatusDeps } from '../core/invoice-status.js'
import { handleCreateInvoice } from '../core/create-invoice.js'
import { handleInvoiceStatus, renderInvoiceStatusHtml } from '../core/invoice-status.js'
import type { StorageBackend } from '../storage/interface.js'

// ── Helpers ──────────────────────────────────────────────────────────

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

// ── Middleware ────────────────────────────────────────────────────────

export interface HonoMiddlewareConfig {
  engine: TollBoothEngine
  upstream: string
}

/**
 * Returns a Hono `MiddlewareHandler` that enforces L402 payment gating.
 *
 * On `pass` or `proxy` results, the request is forwarded to the upstream.
 * On `challenge`, a 402 response is returned with invoice details.
 */
export function createHonoMiddleware(config: HonoMiddlewareConfig): MiddlewareHandler {
  const upstream = config.upstream.replace(/\/$/, '')

  return async (c) => {
    const url = new URL(c.req.url)
    const ip = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? '127.0.0.1'
    const headers = Object.fromEntries(c.req.raw.headers.entries())

    const result = await config.engine.handle({
      method: c.req.method,
      path: url.pathname,
      headers,
      ip,
      body: c.req.raw.body,
    })

    if (result.action === 'pass' || result.action === 'proxy') {
      const res = await proxyUpstream(upstream, c.req.raw)
      return res
    }

    // challenge — 402
    for (const [key, value] of Object.entries(result.headers)) {
      c.header(key, value)
    }
    return c.json(result.body, 402)
  }
}

// ── Invoice status handler ───────────────────────────────────────────

/**
 * Returns a Hono handler that serves invoice status as JSON or HTML.
 *
 * Expects `:paymentHash` route param. When `Accept: text/html` is
 * requested, renders the self-service payment page; otherwise returns
 * a JSON payload with `{ paid, preimage }`.
 */
export function createHonoInvoiceStatusHandler(
  deps: InvoiceStatusDeps,
): (c: Context) => Promise<Response> {
  return async (c) => {
    const paymentHash = c.req.param('paymentHash')
    const accept = c.req.header('Accept') ?? ''

    try {
      if (accept.includes('text/html')) {
        const { html, status } = await renderInvoiceStatusHtml(deps, paymentHash)
        return c.html(html, status as 200)
      }

      const result = await handleInvoiceStatus(deps, paymentHash)
      return c.json({ paid: result.paid, preimage: result.preimage })
    } catch {
      return c.json({ error: 'Failed to check invoice status' }, 502)
    }
  }
}

// ── Create invoice handler ───────────────────────────────────────────

/**
 * Returns a Hono handler that creates a new Lightning invoice.
 *
 * Parses the JSON body for an optional `amountSats` field, delegates
 * to the core `handleCreateInvoice`, and returns the result.
 */
export function createHonoCreateInvoiceHandler(
  deps: CreateInvoiceDeps,
): (c: Context) => Promise<Response> {
  return async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = await handleCreateInvoice(deps, body)

    if (!result.success) {
      return c.json({ error: result.error, tiers: result.tiers }, 400)
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
  }
}

// ── NWC handler ──────────────────────────────────────────────────────

/**
 * Returns a Hono handler that pays a Lightning invoice via Nostr Wallet Connect.
 *
 * Expects JSON body with `{ nwcUri, bolt11 }`. Returns the payment preimage
 * on success or an error message on failure.
 */
export function createHonoNwcHandler(
  nwcPay: (nwcUri: string, bolt11: string) => Promise<string>,
): (c: Context) => Promise<Response> {
  return async (c) => {
    try {
      const { nwcUri, bolt11 } = await c.req.json()
      const preimage = await nwcPay(nwcUri, bolt11)
      return c.json({ preimage })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'NWC payment failed'
      return c.json({ error: message }, 500)
    }
  }
}

// ── Cashu handler ────────────────────────────────────────────────────

/**
 * Returns a Hono handler that redeems a Cashu token as payment.
 *
 * Expects JSON body with `{ token, paymentHash }`. Credits the storage
 * backend and returns the credited amount.
 */
export function createHonoCashuHandler(
  redeem: (token: string, paymentHash: string) => Promise<number>,
  storage: StorageBackend,
): (c: Context) => Promise<Response> {
  return async (c) => {
    try {
      const { token, paymentHash } = await c.req.json()
      const credited = await redeem(token, paymentHash)
      storage.credit(paymentHash, credited)
      return c.json({ credited })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cashu redemption failed'
      return c.json({ error: message }, 500)
    }
  }
}
