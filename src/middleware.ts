// src/middleware.ts
import type { Context, MiddlewareHandler } from 'hono'
import type { GateConfig, PaymentEvent, RequestEvent } from './types.js'
import { mintMacaroon, verifyMacaroon } from './macaroon.js'
import { FreeTier } from './free-tier.js'
import { CreditMeter } from './meter.js'
import { createHash, randomBytes } from 'node:crypto'

export type EventHandler = {
  onPayment?: (event: PaymentEvent) => void
  onRequest?: (event: RequestEvent) => void
}

export function lightningGate(config: GateConfig & EventHandler): MiddlewareHandler {
  const rootKey = config.rootKey ?? randomBytes(32).toString('hex')
  const defaultAmount = config.defaultInvoiceAmount ?? 1000
  const meter = new CreditMeter(config.dbPath ?? ':memory:')
  const freeTier = config.freeTier ? new FreeTier(config.freeTier.requestsPerDay) : null
  const upstream = config.upstream.replace(/\/$/, '')

  return async (c: Context, next) => {
    const start = Date.now()
    const path = new URL(c.req.url).pathname
    const cost = config.pricing[path]

    // If path has no pricing entry, proxy directly (health checks, etc.)
    if (cost === undefined) {
      return proxyUpstream(c, upstream)
    }

    // Check for L402 Authorisation header
    const authHeader = c.req.header('Authorization')
    if (authHeader?.startsWith('L402 ')) {
      const result = handleL402Auth(authHeader, rootKey, meter, cost, defaultAmount)
      if (result.authorised) {
        config.onPayment?.({
          timestamp: new Date().toISOString(),
          paymentHash: result.paymentHash!,
          amountSats: cost,
        })
        config.onRequest?.({
          timestamp: new Date().toISOString(),
          endpoint: path,
          satsDeducted: cost,
          remainingBalance: result.remaining,
          latencyMs: Date.now() - start,
          authenticated: true,
        })
        return proxyUpstream(c, upstream)
      }
      // Fall through to issue a new challenge if authorisation failed
    }

    // Check free tier
    if (freeTier) {
      // Note: X-Forwarded-For must be set by a trusted reverse proxy.
      // Deploy behind nginx/Caddy that overwrites this header.
      const ip = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? '127.0.0.1'
      const check = freeTier.check(ip)
      if (check.allowed) {
        config.onRequest?.({
          timestamp: new Date().toISOString(),
          endpoint: path,
          satsDeducted: 0,
          remainingBalance: 0,
          latencyMs: Date.now() - start,
          authenticated: false,
        })
        return proxyUpstream(c, upstream)
      }
    }

    // Issue L402 challenge — credit is NOT stored yet.
    // Credit is only granted when the client presents a valid preimage.
    const invoice = await config.backend.createInvoice(
      defaultAmount,
      `lightning-gate: ${defaultAmount} sats credit`,
    )
    const macaroon = mintMacaroon(rootKey, invoice.paymentHash, defaultAmount)

    c.header('WWW-Authenticate', `L402 macaroon="${macaroon}", invoice="${invoice.bolt11}"`)
    c.header('X-Coverage', 'GB')
    return c.json(
      { error: 'Payment required', invoice: invoice.bolt11, amount_sats: defaultAmount },
      402,
    )
  }
}

function handleL402Auth(
  authHeader: string,
  rootKey: string,
  meter: CreditMeter,
  cost: number,
  defaultAmount: number,
): { authorised: boolean; remaining: number; paymentHash?: string } {
  try {
    // Format: L402 <macaroon>:<preimage>
    const token = authHeader.slice(5) // Remove "L402 "
    const colonIdx = token.lastIndexOf(':')
    if (colonIdx === -1) return { authorised: false, remaining: 0 }

    const macaroonBase64 = token.slice(0, colonIdx)
    const preimage = token.slice(colonIdx + 1)

    const result = verifyMacaroon(rootKey, macaroonBase64)
    if (!result.valid || !result.paymentHash) return { authorised: false, remaining: 0 }

    // Verify the preimage is proof of payment: sha256(preimage) must equal payment_hash
    const computedHash = createHash('sha256')
      .update(Buffer.from(preimage, 'hex'))
      .digest('hex')
    if (computedHash !== result.paymentHash) return { authorised: false, remaining: 0 }

    // Credit on first valid presentation of preimage (idempotent via upsert)
    if (meter.balance(result.paymentHash) === 0) {
      meter.credit(result.paymentHash, result.creditBalance ?? defaultAmount)
    }

    // Debit credit for this request
    const debit = meter.debit(result.paymentHash, cost)
    if (!debit.success) return { authorised: false, remaining: debit.remaining }

    return { authorised: true, remaining: debit.remaining, paymentHash: result.paymentHash }
  } catch {
    return { authorised: false, remaining: 0 }
  }
}

async function proxyUpstream(c: Context, upstream: string): Promise<Response> {
  const url = new URL(c.req.url)
  const targetUrl = `${upstream}${url.pathname}${url.search}`

  try {
    const headers = new Headers(c.req.raw.headers)
    headers.delete('Authorization') // Do not forward L402 authorisation to upstream
    headers.delete('Host')

    const res = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      // @ts-expect-error duplex is required for streaming request body
      duplex: 'half',
      signal: AbortSignal.timeout(30_000),
    })

    const responseHeaders = new Headers(res.headers)
    responseHeaders.set('X-Coverage', 'GB')

    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders,
    })
  } catch {
    c.header('X-Coverage', 'GB')
    return c.json({ error: 'Upstream routing engine unavailable' }, 502)
  }
}
