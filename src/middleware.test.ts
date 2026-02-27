// src/middleware.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { tollBooth } from './middleware.js'
import { mintMacaroon } from './macaroon.js'
import type { LightningBackend } from './types.js'

const ROOT_KEY = 'a'.repeat(64)

function mockBackend(): LightningBackend {
  return {
    createInvoice: vi.fn().mockResolvedValue({
      bolt11: 'lnbc100n1mock...',
      paymentHash: 'b'.repeat(64),
    }),
    checkInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'c'.repeat(64) }),
  }
}

function createApp(backend: LightningBackend, overrides?: Record<string, unknown>) {
  const app = new Hono()
  const booth = tollBooth({
    backend,
    pricing: { '/route': 2, '/isochrone': 5 },
    upstream: 'http://localhost:8002',
    freeTier: { requestsPerDay: 3 },
    rootKey: ROOT_KEY,
    dbPath: ':memory:',
    ...overrides,
  })
  app.use('/*', booth)
  return app
}

/** Generate a preimage whose SHA-256 equals the given hash. For tests only. */
function preimageForHash(hash: string): string {
  // We can't reverse SHA-256, so instead we create a known preimage first
  // and derive the hash from it. Used in tests below.
  return hash // placeholder — see makePreimageAndHash below
}

/** Create a matching preimage + paymentHash pair for test use. */
function makePreimageAndHash(): { preimage: string; paymentHash: string } {
  const preimage = 'deadbeef'.repeat(8) // 32 bytes hex
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
  return { preimage, paymentHash }
}

describe('tollBooth middleware', () => {
  describe('free tier', () => {
    it('serves requests within free tier limit', async () => {
      const app = createApp(mockBackend())
      const res = await app.request('/route', { method: 'POST' })
      // The upstream is not reachable in tests, but the middleware should attempt to proxy.
      // We confirm it did not return 402.
      expect(res.status).not.toBe(402)
    })

    it('returns 402 when free tier is exhausted', async () => {
      const app = createApp(mockBackend())
      // Exhaust free tier
      for (let i = 0; i < 3; i++) {
        await app.request('/route', {
          method: 'POST',
          headers: { 'X-Forwarded-For': '1.2.3.4' },
        })
      }
      const res = await app.request('/route', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '1.2.3.4' },
      })
      expect(res.status).toBe(402)
      expect(res.headers.get('WWW-Authenticate')).toMatch(/^L402 /)
    })
  })

  describe('L402 authentication', () => {
    it('returns 402 with macaroon and invoice when no free tier configured', async () => {
      const backend = mockBackend()
      const app = createApp(backend, { freeTier: undefined })

      const res = await app.request('/route', { method: 'POST' })
      expect(res.status).toBe(402)

      const wwwAuth = res.headers.get('WWW-Authenticate')!
      expect(wwwAuth).toMatch(/^L402 macaroon="[^"]+", invoice="lnbc/)
    })

    it('rejects invalid Authorization header', async () => {
      const app = createApp(mockBackend(), { freeTier: undefined })
      const res = await app.request('/route', {
        method: 'POST',
        headers: { 'Authorization': 'L402 garbage' },
      })
      expect(res.status).toBe(402)
    })

    it('accepts valid L402 token with correct preimage', async () => {
      const { preimage, paymentHash } = makePreimageAndHash()

      // Create a backend that returns invoices with the known paymentHash
      const backend: LightningBackend = {
        createInvoice: vi.fn().mockResolvedValue({
          bolt11: 'lnbc100n1mock...',
          paymentHash,
        }),
        checkInvoice: vi.fn().mockResolvedValue({ paid: true, preimage }),
      }
      const app = createApp(backend, { freeTier: undefined })

      // Mint a valid macaroon for this payment hash
      const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
      const authToken = `L402 ${macaroon}:${preimage}`

      const res = await app.request('/route', {
        method: 'POST',
        headers: { 'Authorization': authToken },
      })
      // Should proxy (502 because upstream is not running, but NOT 402)
      expect(res.status).not.toBe(402)
    })

    it('rejects L402 token with wrong preimage', async () => {
      const { paymentHash } = makePreimageAndHash()
      const wrongPreimage = 'ff'.repeat(32) // does not hash to paymentHash

      const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
      const authToken = `L402 ${macaroon}:${wrongPreimage}`

      const app = createApp(mockBackend(), { freeTier: undefined })
      const res = await app.request('/route', {
        method: 'POST',
        headers: { 'Authorization': authToken },
      })
      expect(res.status).toBe(402)
    })
  })

  describe('credit management', () => {
    it('does not pre-credit on 402 issuance', async () => {
      const { preimage, paymentHash } = makePreimageAndHash()
      const backend: LightningBackend = {
        createInvoice: vi.fn().mockResolvedValue({
          bolt11: 'lnbc100n1mock...',
          paymentHash,
        }),
        checkInvoice: vi.fn(),
      }
      const app = createApp(backend, { freeTier: undefined })

      // Get a 402 challenge
      const res = await app.request('/route', { method: 'POST' })
      expect(res.status).toBe(402)

      // Try to use the macaroon from the challenge WITHOUT a valid preimage
      const wwwAuth = res.headers.get('WWW-Authenticate')!
      const macaroonMatch = wwwAuth.match(/macaroon="([^"]+)"/)!
      const macaroon = macaroonMatch[1]
      const wrongPreimage = 'ff'.repeat(32)

      const res2 = await app.request('/route', {
        method: 'POST',
        headers: { 'Authorization': `L402 ${macaroon}:${wrongPreimage}` },
      })
      // Should still get 402 — wrong preimage means no credit
      expect(res2.status).toBe(402)
    })
  })

  describe('coverage header', () => {
    it('includes X-Coverage header on all responses', async () => {
      const app = createApp(mockBackend())
      const res = await app.request('/route', { method: 'POST' })
      expect(res.headers.get('X-Coverage')).toBeTruthy()
    })
  })
})
