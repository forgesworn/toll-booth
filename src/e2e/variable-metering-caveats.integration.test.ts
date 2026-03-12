// src/e2e/variable-metering-caveats.integration.test.ts
//
// End-to-end tests for variable metering (reconcile) and caveat-scoped macaroons.
// Uses in-memory storage and a mock backend — no external services required.
// These tests always run as part of the standard test suite.
//
import { describe, it, expect, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import express from 'express'
import { createTollBooth } from '../core/toll-booth.js'
import { memoryStorage } from '../storage/memory.js'
import { mintMacaroon, parseCaveats } from '../macaroon.js'
import { handleCreateInvoice } from '../core/create-invoice.js'
import { createExpressMiddleware } from '../adapters/express.js'
import type { LightningBackend } from '../types.js'

const ROOT_KEY = randomBytes(32).toString('hex')

/** Creates a fresh preimage/paymentHash pair. */
function makeCredential(): { preimage: string; paymentHash: string } {
  const preimage = randomBytes(32).toString('hex')
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
  return { preimage, paymentHash }
}

/** Builds a mock LightningBackend that never actually sends invoices. */
function mockBackend(): LightningBackend {
  return {
    createInvoice: vi.fn().mockResolvedValue({ bolt11: 'lnbc1mock', paymentHash: randomBytes(32).toString('hex') }),
    checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
  }
}

describe('variable metering and caveat-scoped macaroons', () => {
  it('full flow: create invoice with caveats, pay, request with X-Toll-Cost reconciliation', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend: mockBackend(),
      storage,
      pricing: { '/api/chat': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    // Step 1: Request the priced endpoint without auth — expect a 402 challenge
    const challengeResult = await engine.handle({
      method: 'GET',
      path: '/api/chat',
      headers: {},
      ip: '127.0.0.1',
    })

    expect(challengeResult.action).toBe('challenge')

    // Step 2: Simulate payment out-of-band with a fresh credential
    const { preimage, paymentHash } = makeCredential()
    storage.settleWithCredit(paymentHash, 1000, preimage)

    // Step 3: Mint a macaroon carrying custom caveats
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, [
      'route = /api/*',
      'model = llama3',
    ])

    // Step 4: Request with L402 auth on a matching path
    const authHeader = `L402 ${macaroon}:${preimage}`
    const proxyResult = await engine.handle({
      method: 'POST',
      path: '/api/chat',
      headers: { authorization: authHeader },
      ip: '127.0.0.1',
    })

    expect(proxyResult.action).toBe('proxy')
    if (proxyResult.action !== 'proxy') return // narrow type

    // Cost was estimated at 10 sats (the configured price for /api/chat)
    expect(proxyResult.paymentHash).toBe(paymentHash)
    expect(proxyResult.estimatedCost).toBe(10)

    // Custom caveat should be forwarded as a header to the upstream
    expect(proxyResult.headers['X-Toll-Caveat-Model']).toBe('llama3')

    // Remaining balance after deducting estimated cost: 1000 - 10 = 990
    expect(proxyResult.creditBalance).toBe(990)

    // Step 5: Reconcile — actual cost was only 3, so 7 sats are refunded
    const reconciled = engine.reconcile(paymentHash, 3)

    expect(reconciled.adjusted).toBe(true)
    expect(reconciled.delta).toBe(7)
    // 1000 - 10 + 7 = 997
    expect(reconciled.newBalance).toBe(997)
  })

  it('rejects request when route caveat does not match', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend: mockBackend(),
      storage,
      pricing: { '/api/chat': 10, '/other/path': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    const { preimage, paymentHash } = makeCredential()
    storage.settleWithCredit(paymentHash, 1000, preimage)

    // Macaroon is scoped to /api/* only
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, ['route = /api/*'])
    const authHeader = `L402 ${macaroon}:${preimage}`

    // Request a path outside the allowed route pattern
    const result = await engine.handle({
      method: 'GET',
      path: '/other/path',
      headers: { authorization: authHeader },
      ip: '127.0.0.1',
    })

    // Macaroon is cryptographically valid but fails the route caveat — expect a fresh challenge
    expect(result.action).toBe('challenge')
  })

  it('rejects request when macaroon is expired', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend: mockBackend(),
      storage,
      pricing: { '/api/chat': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    const { preimage, paymentHash } = makeCredential()
    storage.settleWithCredit(paymentHash, 1000, preimage)

    // Expiry timestamp is well in the past
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, [
      'expires = 2020-01-01T00:00:00Z',
    ])
    const authHeader = `L402 ${macaroon}:${preimage}`

    const result = await engine.handle({
      method: 'GET',
      path: '/api/chat',
      headers: { authorization: authHeader },
      ip: '127.0.0.1',
    })

    // Macaroon has expired — expect a fresh payment challenge
    expect(result.action).toBe('challenge')
  })

  it('rejects request when ip caveat does not match', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend: mockBackend(),
      storage,
      pricing: { '/api/chat': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    const { preimage, paymentHash } = makeCredential()
    storage.settleWithCredit(paymentHash, 1000, preimage)

    // Macaroon is bound to IP 10.0.0.1 only
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, ['ip = 10.0.0.1'])
    const authHeader = `L402 ${macaroon}:${preimage}`

    // Request arrives from a different IP — caveat should fail
    const result = await engine.handle({
      method: 'GET',
      path: '/api/chat',
      headers: { authorization: authHeader },
      ip: '99.99.99.99',
    })

    // The ip caveat does not match — expect a fresh challenge
    expect(result.action).toBe('challenge')
  })

  it('invoice rate limiting rejects after maxPendingPerIp', async () => {
    const storage = memoryStorage()
    // Use a backend that generates a fresh payment hash on each call so that
    // storeInvoice records each invoice as a distinct pending entry.
    const backend: LightningBackend = {
      createInvoice: vi.fn().mockImplementation(() =>
        Promise.resolve({ bolt11: 'lnbc1mock', paymentHash: randomBytes(32).toString('hex') }),
      ),
      checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
    }
    const deps = {
      backend,
      storage,
      rootKey: ROOT_KEY,
      tiers: [],
      defaultAmount: 1000,
      maxPendingPerIp: 2,
    }

    // First two requests from the same IP should succeed
    const first = await handleCreateInvoice(deps, { clientIp: '1.2.3.4' })
    expect(first.success).toBe(true)

    const second = await handleCreateInvoice(deps, { clientIp: '1.2.3.4' })
    expect(second.success).toBe(true)

    // Third request exceeds maxPendingPerIp — should be rate-limited
    const third = await handleCreateInvoice(deps, { clientIp: '1.2.3.4' })
    expect(third.success).toBe(false)
    expect(third.status).toBe(429)
  })

  it('X-Toll-Cost reconciliation through Express adapter HTTP round-trip', async () => {
    // Real upstream server that reports an actual cost of 3 via X-Toll-Cost
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Toll-Cost': '3' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => upstream.listen(0, resolve))
    const upstreamPort = (upstream.address() as { port: number }).port

    try {
      const storage = memoryStorage()
      const engine = createTollBooth({
        backend: mockBackend(),
        storage,
        pricing: { '/api/chat': 10 },
        upstream: `http://127.0.0.1:${upstreamPort}`,
        rootKey: ROOT_KEY,
        defaultInvoiceAmount: 1000,
      })

      // Settle 1000 sats out-of-band
      const { preimage, paymentHash } = makeCredential()
      storage.settleWithCredit(paymentHash, 1000, preimage)

      const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
      const authHeader = `L402 ${macaroon}:${preimage}`

      const app = express()
      app.use('/api', createExpressMiddleware({
        engine,
        upstream: `http://127.0.0.1:${upstreamPort}`,
      }))

      // Make a real HTTP request through the Express adapter
      const { createServer } = await import('node:http')
      const res = await new Promise<Response>((resolve, reject) => {
        const server = createServer(app)
        server.listen(0, () => {
          const addr = server.address() as { port: number }
          fetch(`http://127.0.0.1:${addr.port}/api/chat`, {
            headers: { Authorization: authHeader },
          })
            .then(resolve)
            .catch(reject)
            .finally(() => server.close())
        })
      })

      expect(res.status).toBe(200)
      // Engine debits 10 (estimated), then upstream reports 3 (actual).
      // Reconciliation refunds 7, so final balance = 1000 - 10 + 7 = 997.
      expect(res.headers.get('x-credit-balance')).toBe('997')
    } finally {
      upstream.close()
    }
  })

  it('create-invoice handler includes caveats in minted macaroon', async () => {
    const storage = memoryStorage()
    const deps = {
      backend: mockBackend(),
      storage,
      rootKey: ROOT_KEY,
      tiers: [],
      defaultAmount: 1000,
    }

    const result = await handleCreateInvoice(deps, {
      caveats: ['route = /api/*', 'model = gpt4'],
    })

    expect(result.success).toBe(true)
    if (!result.success) return // narrow type

    // Parse the minted macaroon and verify the custom caveats are present
    const caveats = parseCaveats(result.data!.macaroon)
    expect(caveats['route']).toBe('/api/*')
    expect(caveats['model']).toBe('gpt4')
  })

  it('reconciliation with higher actual cost deducts additional sats', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend: mockBackend(),
      storage,
      pricing: { '/api/chat': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    // Settle 1000 sats, then make an authenticated request (debits estimated 10)
    const { preimage, paymentHash } = makeCredential()
    storage.settleWithCredit(paymentHash, 1000, preimage)

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const authHeader = `L402 ${macaroon}:${preimage}`

    const proxyResult = await engine.handle({
      method: 'POST',
      path: '/api/chat',
      headers: { authorization: authHeader },
      ip: '127.0.0.1',
    })

    expect(proxyResult.action).toBe('proxy')
    // Balance after estimated debit: 1000 - 10 = 990

    // Upstream reports actual cost of 25 — more than the 10 that was estimated
    const reconciled = engine.reconcile(paymentHash, 25)

    // Delta is estimated - actual = 10 - 25 = -15 (additional charge)
    expect(reconciled.adjusted).toBe(true)
    expect(reconciled.delta).toBe(-15)
    // Final balance: 990 + (-15) = 975
    expect(reconciled.newBalance).toBe(975)
  })
})
