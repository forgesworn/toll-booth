// src/e2e/tiered-pricing.integration.test.ts
//
// End-to-end test for tiered pricing through the Express adapter (Booth class).
// Uses in-memory storage and a mock backend; no external services required.
//
import { describe, it, expect, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import express from 'express'
import { Booth } from '../booth.js'
import { memoryStorage } from '../storage/memory.js'
import { mintMacaroon } from '../macaroon.js'
import type { StorageBackend } from '../storage/interface.js'
import type { LightningBackend, RequestEvent } from '../types.js'

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
    createInvoice: vi.fn().mockResolvedValue({
      bolt11: 'lnbc1mock',
      paymentHash: randomBytes(32).toString('hex'),
    }),
    checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
  }
}

interface TestStack {
  upstream: http.Server
  appServer: http.Server
  booth: Booth
  baseUrl: string
  storage: StorageBackend
  requestEvents: RequestEvent[]
  close: () => void
}

/** Spins up an upstream, Booth, and Express app. Caller must call close(). */
async function createTestStack(): Promise<TestStack> {
  const requestEvents: RequestEvent[] = []

  // Upstream echoes request details
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      path: req.url,
      tollTier: req.headers['x-toll-tier'],
    }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, resolve))
  const upstreamPort = (upstream.address() as { port: number }).port

  const storage = memoryStorage()
  const booth = new Booth({
    adapter: 'express',
    backend: mockBackend(),
    storage,
    pricing: {
      '/api/joke': { default: 5, standard: 21, premium: 42 },
      '/api/health': 0,
    },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    rootKey: ROOT_KEY,
    freeTier: { requestsPerDay: 1 },
    defaultInvoiceAmount: 1000,
    getClientIp: () => '10.0.0.1',
    onRequest: (event) => requestEvents.push(event),
  })

  const app = express()
  app.use(express.json())
  app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as express.RequestHandler)
  app.post('/create-invoice', booth.createInvoiceHandler as express.RequestHandler)
  app.use('/', booth.middleware as express.RequestHandler)

  const appServer = http.createServer(app)
  await new Promise<void>((resolve) => appServer.listen(0, resolve))
  const appPort = (appServer.address() as { port: number }).port

  return {
    upstream,
    appServer,
    booth,
    baseUrl: `http://127.0.0.1:${appPort}`,
    storage,
    requestEvents,
    close: () => {
      appServer.close()
      upstream.close()
      booth.close()
    },
  }
}

/** Settle credits out-of-band, mint a macaroon, and return the L402 auth header. */
function settleAndAuth(storage: StorageBackend, amount: number): { authHeader: string; paymentHash: string } {
  const { preimage, paymentHash } = makeCredential()
  storage.settleWithCredit(paymentHash, amount, preimage)
  const macaroon = mintMacaroon(ROOT_KEY, paymentHash, amount)
  return { authHeader: `L402 ${macaroon}:${preimage}`, paymentHash }
}

describe('tiered pricing end-to-end (Express adapter)', () => {
  it('free tier works; tier param is ignored during free tier', async () => {
    const stack = await createTestStack()
    try {
      // First request should be free regardless of tier param
      const res = await fetch(`${stack.baseUrl}/api/joke?tier=premium`)
      expect(res.status).toBe(200)

      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(true)

      // Free-tier header should be present
      expect(res.headers.get('x-free-remaining')).toBe('0')

      // No tier-related header on free-tier responses
      expect(res.headers.get('x-toll-tier')).toBeNull()
    } finally {
      stack.close()
    }
  })

  it('free tier exhausted returns 402 with tiers map', async () => {
    const stack = await createTestStack()
    try {
      // Exhaust free tier
      const free = await fetch(`${stack.baseUrl}/api/joke`)
      expect(free.status).toBe(200)

      // Second request should get 402
      const res = await fetch(`${stack.baseUrl}/api/joke`)
      expect(res.status).toBe(402)

      const body = await res.json() as {
        tiers: Record<string, { sats: number }>
        message: string
      }

      expect(body.message).toBe('Payment required.')
      expect(body.tiers).toEqual({
        default: { sats: 5 },
        standard: { sats: 21 },
        premium: { sats: 42 },
      })
    } finally {
      stack.close()
    }
  })

  it('request with ?tier=premium debits 42 sats and sets X-Toll-Tier', async () => {
    const stack = await createTestStack()
    try {
      // Exhaust free tier
      await fetch(`${stack.baseUrl}/api/joke`)

      const { authHeader } = settleAndAuth(stack.storage, 1000)

      const res = await fetch(`${stack.baseUrl}/api/joke?tier=premium`, {
        headers: { Authorization: authHeader },
      })
      expect(res.status).toBe(200)

      const body = await res.json() as { ok: boolean; tollTier?: string }
      expect(body.ok).toBe(true)

      // 42 sats debited from 1000 = 958 remaining
      expect(res.headers.get('x-credit-balance')).toBe('958')
      // The resolved tier goes to the upstream, not back to the client
      expect(body.tollTier).toBe('premium')
      expect(res.headers.get('x-toll-tier')).toBeNull()
    } finally {
      stack.close()
    }
  })

  it('request with ?tier=default debits 5 sats', async () => {
    const stack = await createTestStack()
    try {
      await fetch(`${stack.baseUrl}/api/joke`)

      const { authHeader } = settleAndAuth(stack.storage, 1000)

      const res = await fetch(`${stack.baseUrl}/api/joke?tier=default`, {
        headers: { Authorization: authHeader },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-credit-balance')).toBe('995') // 1000 - 5
      expect((await res.json() as { tollTier?: string }).tollTier).toBe('default')
    } finally {
      stack.close()
    }
  })

  it('request without tier param defaults to 5 sats (default tier)', async () => {
    const stack = await createTestStack()
    try {
      await fetch(`${stack.baseUrl}/api/joke`)

      const { authHeader } = settleAndAuth(stack.storage, 1000)

      // No tier param; should resolve to 'default' tier at 5 sats
      const res = await fetch(`${stack.baseUrl}/api/joke`, {
        headers: { Authorization: authHeader },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-credit-balance')).toBe('995') // 1000 - 5
      expect((await res.json() as { tollTier?: string }).tollTier).toBe('default')
    } finally {
      stack.close()
    }
  })

  it('request with unknown tier returns 402 challenge', async () => {
    const stack = await createTestStack()
    try {
      await fetch(`${stack.baseUrl}/api/joke`)

      const { authHeader } = settleAndAuth(stack.storage, 1000)

      // Unknown tier should trigger a 402 even with valid credentials
      const res = await fetch(`${stack.baseUrl}/api/joke?tier=ultra-mega`, {
        headers: { Authorization: authHeader },
      })
      expect(res.status).toBe(402)

      const body = await res.json() as { tiers: Record<string, { sats: number }> }
      expect(body.tiers).toEqual({
        default: { sats: 5 },
        standard: { sats: 21 },
        premium: { sats: 42 },
      })
    } finally {
      stack.close()
    }
  })

  it('onRequest callback has correct tier field for each authenticated request', async () => {
    const stack = await createTestStack()
    try {
      await fetch(`${stack.baseUrl}/api/joke`)

      const { authHeader } = settleAndAuth(stack.storage, 1000)

      // Clear events from free-tier request
      stack.requestEvents.length = 0

      // Premium
      await fetch(`${stack.baseUrl}/api/joke?tier=premium`, {
        headers: { Authorization: authHeader },
      })

      // Default (no param)
      await fetch(`${stack.baseUrl}/api/joke`, {
        headers: { Authorization: authHeader },
      })

      // Standard
      await fetch(`${stack.baseUrl}/api/joke?tier=standard`, {
        headers: { Authorization: authHeader },
      })

      const events = stack.requestEvents.filter((e) => e.authenticated)
      expect(events).toHaveLength(3)

      expect(events[0].tier).toBe('premium')
      expect(events[0].satsDeducted).toBe(42)

      expect(events[1].tier).toBe('default')
      expect(events[1].satsDeducted).toBe(5)

      expect(events[2].tier).toBe('standard')
      expect(events[2].satsDeducted).toBe(21)
    } finally {
      stack.close()
    }
  })

  it('flat-priced route is unchanged; tier is undefined', async () => {
    const stack = await createTestStack()
    try {
      // Exhaust free tier on /api/joke
      await fetch(`${stack.baseUrl}/api/joke`)

      const { authHeader } = settleAndAuth(stack.storage, 1000)

      stack.requestEvents.length = 0

      // /api/health is flat-priced at 0; authenticated request
      const res = await fetch(`${stack.baseUrl}/api/health`, {
        headers: { Authorization: authHeader },
      })
      expect(res.status).toBe(200)

      // Balance unchanged (0 sats deducted for a flat 0-cost route)
      expect(res.headers.get('x-credit-balance')).toBe('1000')

      // X-Toll-Tier header should NOT be present on flat-priced routes
      expect(res.headers.get('x-toll-tier')).toBeNull()

      // onRequest event should have tier undefined
      const events = stack.requestEvents.filter((e) => e.authenticated)
      expect(events).toHaveLength(1)
      expect(events[0].tier).toBeUndefined()
      expect(events[0].satsDeducted).toBe(0)
    } finally {
      stack.close()
    }
  })
})
