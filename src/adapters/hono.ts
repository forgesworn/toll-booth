// src/adapters/hono.ts
import type { Context, MiddlewareHandler } from 'hono'
import type { TollBoothEngine } from '../core/toll-booth.js'
import type { CreateInvoiceDeps } from '../core/create-invoice.js'
import type { InvoiceStatusDeps } from '../core/invoice-status.js'
import { handleCreateInvoice } from '../core/create-invoice.js'
import { handleInvoiceStatus, renderInvoiceStatusHtml } from '../core/invoice-status.js'
import type { StorageBackend } from '../storage/interface.js'
import { PAYMENT_HASH_RE } from '../core/types.js'

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
  trustProxy?: boolean
  responseHeaders?: Record<string, string>
}

/**
 * Returns a Hono `MiddlewareHandler` that enforces L402 payment gating.
 *
 * On `pass` or `proxy` results, the request is forwarded to the upstream.
 * On `challenge`, a 402 response is returned with invoice details.
 */
export function createHonoMiddleware(config: HonoMiddlewareConfig): MiddlewareHandler {
  const upstream = config.upstream.replace(/\/$/, '')

  const extraHeaders = config.responseHeaders ?? {}

  return async (c) => {
    const url = new URL(c.req.url)
    const ip = config.trustProxy
      ? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? c.req.header('X-Real-IP') ?? '127.0.0.1'
      : '127.0.0.1'
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
      // Merge engine headers + responseHeaders onto the upstream response
      const merged = new Headers(res.headers)
      for (const [key, value] of Object.entries(result.headers)) {
        merged.set(key, value)
      }
      for (const [key, value] of Object.entries(extraHeaders)) {
        merged.set(key, value)
      }
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: merged,
      })
    }

    // challenge — 402
    for (const [key, value] of Object.entries(result.headers)) {
      c.header(key, value)
    }
    for (const [key, value] of Object.entries(extraHeaders)) {
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
    const paymentHash = c.req.param('paymentHash') ?? ''
    if (!PAYMENT_HASH_RE.test(paymentHash)) {
      return c.json({ error: 'Invalid payment hash' }, 400)
    }
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
 * Expects JSON body with `{ token, paymentHash }`. Uses a durable
 * write-ahead claim (persisted to storage) before calling the external
 * Cashu mint, so that:
 * - Multiple app instances sharing the same DB cannot both call redeem()
 * - If the process crashes after redeem() but before settlement, the
 *   claim survives for recovery on restart via pendingClaims()
 */
export const REDEEM_LEASE_MS = 30_000
const REDEEM_LEASE_RENEW_MS = Math.max(1_000, Math.floor(REDEEM_LEASE_MS / 2))

async function withLeaseKeepAlive<T>(
  storage: StorageBackend,
  paymentHash: string,
  fn: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    storage.extendRecoveryLease(paymentHash, REDEEM_LEASE_MS)
  }, REDEEM_LEASE_RENEW_MS)

  try {
    return await fn()
  } finally {
    clearInterval(timer)
  }
}

export function createHonoCashuHandler(
  redeem: (token: string, paymentHash: string) => Promise<number>,
  storage: StorageBackend,
): (c: Context) => Promise<Response> {
  return async (c) => {
    try {
      const { token, paymentHash } = await c.req.json()
      if (typeof token !== 'string' || !token || !PAYMENT_HASH_RE.test(paymentHash)) {
        return c.json({ error: 'Invalid request: token (string) and paymentHash (64 hex chars) required' }, 400)
      }

      // Reject unknown payment hashes — must have been issued by this server
      if (!storage.getInvoice(paymentHash) && !storage.isSettled(paymentHash)) {
        return c.json({ error: 'Unknown payment hash — no invoice found for this hash' }, 400)
      }

      // Fast path: already settled
      if (storage.isSettled(paymentHash)) {
        const invoice = storage.getInvoice(paymentHash)
        return c.json({ credited: 0, macaroon: invoice?.macaroon })
      }

      // Durable claim with exclusive lease — written to DB before the
      // irreversible mint call. Only one process/instance wins (atomic INSERT).
      if (!storage.claimForRedeem(paymentHash, token, REDEEM_LEASE_MS)) {
        // Already settled — idempotent success
        if (storage.isSettled(paymentHash)) {
          const invoice = storage.getInvoice(paymentHash)
          return c.json({ credited: 0, macaroon: invoice?.macaroon })
        }

        // Pending claim exists — try to acquire exclusive recovery lease.
        // Only succeeds if the previous lease has expired (holder crashed or timed out).
        const pendingClaim = storage.tryAcquireRecoveryLease(paymentHash, REDEEM_LEASE_MS)
        if (pendingClaim) {
          try {
            const credited = await withLeaseKeepAlive(storage, paymentHash, () =>
              redeem(pendingClaim.token, paymentHash),
            )
            const newlySettled = storage.settleWithCredit(paymentHash, credited)
            const invoice = storage.getInvoice(paymentHash)
            return c.json({ credited: newlySettled ? credited : 0, macaroon: invoice?.macaroon })
          } catch {
            // Recovery also failed — lease will expire, allowing future retry
            return c.json({ state: 'pending', retryAfterMs: 2000 }, 202)
          }
        }

        // Lease still held by another request/process — tell client to retry
        return c.json({ state: 'pending', retryAfterMs: 2000 }, 202)
      }

      // We hold the exclusive claim — call the external mint
      try {
        const credited = await withLeaseKeepAlive(storage, paymentHash, () =>
          redeem(token, paymentHash),
        )
        const newlySettled = storage.settleWithCredit(paymentHash, credited)
        const invoice = storage.getInvoice(paymentHash)
        return c.json({ credited: newlySettled ? credited : 0, macaroon: invoice?.macaroon })
      } catch {
        // Mint call failed — claim stays pending, lease will expire for recovery
        return c.json({ state: 'pending', retryAfterMs: 2000 }, 202)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cashu redemption failed'
      return c.json({ error: message }, 500)
    }
  }
}
