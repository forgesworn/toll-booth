// src/middleware.ts
import type { Context, MiddlewareHandler } from 'hono'
import type { BoothConfig, PaymentEvent, RequestEvent, ChallengeEvent } from './types.js'
import { mintMacaroon, verifyMacaroon } from './macaroon.js'
import { FreeTier } from './free-tier.js'
import { CreditMeter } from './meter.js'
import type { InvoiceStore } from './invoice-store.js'
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { getTrustedClientIp } from './client-ip.js'

export type EventHandler = {
  onPayment?: (event: PaymentEvent) => void
  onRequest?: (event: RequestEvent) => void
  onChallenge?: (event: ChallengeEvent) => void
}

export interface MiddlewareInternals {
  _invoiceStore?: InvoiceStore
  _meter?: CreditMeter
  _rootKey?: string
  _freeTier?: FreeTier | null
}

export interface TollBoothMiddleware extends MiddlewareHandler {
  /** Close the internal SQLite database (only needed when using tollBooth() standalone, not via Booth). */
  close?: () => void
}

export function tollBooth(config: BoothConfig & EventHandler & MiddlewareInternals): TollBoothMiddleware {
  const suppliedKey = config._rootKey ?? config.rootKey
  if (suppliedKey && !/^[0-9a-f]{64}$/i.test(suppliedKey)) {
    throw new Error(
      `rootKey must be exactly 64 hex characters (32 bytes), got ${suppliedKey.length} characters`,
    )
  }
  const rootKey = suppliedKey ?? randomBytes(32).toString('hex')
  const defaultAmount = config.defaultInvoiceAmount ?? 1000
  const trustProxy = config.trustProxy ?? false
  let meter: CreditMeter
  let ownedDb: Database.Database | null = null
  if (config._meter) {
    meter = config._meter
  } else {
    ownedDb = new Database(config.dbPath ?? './toll-booth.db')
    ownedDb.pragma('journal_mode = WAL')
    meter = new CreditMeter(ownedDb)
  }
  const invoiceStore = config._invoiceStore
  const freeTier = config._freeTier !== undefined
    ? config._freeTier
    : (config.freeTier ? new FreeTier(config.freeTier.requestsPerDay) : null)
  const upstream = config.upstream.replace(/\/$/, '')
  const extraHeaders = config.responseHeaders ?? {}
  const upstreamTimeout = config.upstreamTimeout ?? 30_000

  const handler: TollBoothMiddleware = async (c: Context, next) => {
    const start = Date.now()
    const path = new URL(c.req.url).pathname
    const cost = resolveCost(path, config.pricing)

    // If path has no pricing entry, proxy directly (health checks, etc.)
    if (cost === undefined) {
      return proxyUpstream(c, upstream, extraHeaders, upstreamTimeout)
    }

    // Check for L402 Authorisation header
    const authHeader = c.req.header('Authorization')
    if (authHeader?.startsWith('L402 ')) {
      const result = handleL402Auth(authHeader, rootKey, meter, cost, defaultAmount)
      if (result.authorised) {
        // Fire onPayment once when an invoice is first settled (credit granted)
        if (result.creditedAmount) {
          config.onPayment?.({
            timestamp: new Date().toISOString(),
            paymentHash: result.paymentHash!,
            amountSats: result.creditedAmount,
          })
        }
        config.onRequest?.({
          timestamp: new Date().toISOString(),
          endpoint: path,
          satsDeducted: cost,
          remainingBalance: result.remaining,
          latencyMs: Date.now() - start,
          authenticated: true,
        })
        return proxyUpstream(c, upstream, extraHeaders, upstreamTimeout, result.remaining)
      }
      // Fall through to issue a new challenge if authorisation failed
    }

    // Check free tier (only when client IP is identifiable)
    if (freeTier) {
      const ip = getTrustedClientIp(c, trustProxy)
      if (ip) {
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
          return proxyUpstream(c, upstream, extraHeaders, upstreamTimeout, undefined, check.remaining)
        }
      }
      // No identifiable IP or free tier exhausted — require payment
    }

    // Issue L402 challenge — credit is NOT stored yet.
    // Credit is only granted when the client presents a valid preimage.
    const invoice = await config.backend.createInvoice(
      defaultAmount,
      `toll-booth: ${defaultAmount} sats credit`,
    )
    const macaroon = mintMacaroon(rootKey, invoice.paymentHash, defaultAmount)

    // Store invoice details for the payment page
    invoiceStore?.store(invoice.paymentHash, invoice.bolt11, defaultAmount, macaroon)

    config.onChallenge?.({
      timestamp: new Date().toISOString(),
      endpoint: path,
      amountSats: defaultAmount,
    })

    c.header('WWW-Authenticate', `L402 macaroon="${macaroon}", invoice="${invoice.bolt11}"`)
    for (const [key, value] of Object.entries(extraHeaders)) {
      c.header(key, value)
    }
    return c.json(
      {
        error: 'Payment required',
        invoice: invoice.bolt11,
        macaroon,
        payment_hash: invoice.paymentHash,
        payment_url: `/invoice-status/${invoice.paymentHash}`,
        amount_sats: defaultAmount,
      },
      402,
    )
  }

  if (ownedDb) {
    handler.close = () => ownedDb!.close()
  }

  return handler
}

function handleL402Auth(
  authHeader: string,
  rootKey: string,
  meter: CreditMeter,
  cost: number,
  defaultAmount: number,
): { authorised: boolean; remaining: number; paymentHash?: string; creditedAmount?: number } {
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

    // Credit only once per settled invoice
    let creditedAmount: number | undefined
    const amount = result.creditBalance ?? defaultAmount
    if (meter.creditOnce(result.paymentHash, amount)) {
      creditedAmount = amount
    }

    // Debit credit for this request
    const debit = meter.debit(result.paymentHash, cost)
    if (!debit.success) return { authorised: false, remaining: debit.remaining }

    return { authorised: true, remaining: debit.remaining, paymentHash: result.paymentHash, creditedAmount }
  } catch {
    return { authorised: false, remaining: 0 }
  }
}

async function proxyUpstream(
  c: Context,
  upstream: string,
  extraHeaders: Record<string, string>,
  timeout: number,
  creditBalance?: number,
  freeRemaining?: number,
): Promise<Response> {
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
      signal: AbortSignal.timeout(timeout),
    })

    const responseHeaders = new Headers(res.headers)
    for (const [key, value] of Object.entries(extraHeaders)) {
      responseHeaders.set(key, value)
    }
    if (creditBalance !== undefined) {
      responseHeaders.set('X-Credit-Balance', String(creditBalance))
    }
    if (freeRemaining !== undefined) {
      responseHeaders.set('X-Free-Remaining', String(freeRemaining))
    }

    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders,
    })
  } catch (err) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      c.header(key, value)
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      return c.json({ error: 'Upstream request timed out' }, 504)
    }
    return c.json({ error: 'Upstream routing engine unavailable' }, 502)
  }
}

function resolveCost(path: string, pricing: Record<string, number>): number | undefined {
  if (Object.hasOwn(pricing, path)) return pricing[path]

  let bestMatch: { length: number; cost: number } | undefined
  for (const [pricedPath, cost] of Object.entries(pricing)) {
    if (!pricedPath.startsWith('/')) continue
    if (!path.endsWith(pricedPath)) continue
    if (!bestMatch || pricedPath.length > bestMatch.length) {
      bestMatch = { length: pricedPath.length, cost }
    }
  }
  return bestMatch?.cost
}
