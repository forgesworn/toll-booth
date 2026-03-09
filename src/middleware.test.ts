// src/middleware.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { tollBooth } from './middleware.js'
import { mintMacaroon } from './macaroon.js'
import { InvoiceStore } from './invoice-store.js'
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

/** Create a matching preimage + paymentHash pair for test use. */
function makePreimageAndHash(): { preimage: string; paymentHash: string } {
  const preimage = 'deadbeef'.repeat(8) // 32 bytes hex
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
  return { preimage, paymentHash }
}

describe('tollBooth middleware', () => {
  describe('free tier', () => {
    it('serves requests within free tier limit', async () => {
      const app = createApp(mockBackend(), { trustProxy: true })
      const res = await app.request('/route', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '1.2.3.4' },
      })
      // The upstream is not reachable in tests, but the middleware should attempt to proxy.
      // We confirm it did not return 402.
      expect(res.status).not.toBe(402)
    })

    it('returns 402 when free tier is exhausted', async () => {
      const app = createApp(mockBackend(), { trustProxy: true })
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

    it('skips free tier when trustProxy is disabled (no identifiable client)', async () => {
      const app = createApp(mockBackend(), { freeTier: { requestsPerDay: 10 }, trustProxy: false })

      // Without trustProxy, client IP is unidentifiable — free tier is skipped
      const res = await app.request('/route', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '198.51.100.1' },
      })
      expect(res.status).toBe(402)
    })

    it('uses forwarded client IP only when trustProxy is enabled', async () => {
      const app = createApp(mockBackend(), { freeTier: { requestsPerDay: 1 }, trustProxy: true })

      const a = await app.request('/route', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '198.51.100.1' },
      })
      expect(a.status).not.toBe(402)

      const b = await app.request('/route', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '203.0.113.99' },
      })
      expect(b.status).not.toBe(402)

      const c = await app.request('/route', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '198.51.100.1' },
      })
      expect(c.status).toBe(402)
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

    it('includes macaroon and payment_hash in 402 response body', async () => {
      const backend = mockBackend()
      const app = createApp(backend, { freeTier: undefined })

      const res = await app.request('/route', { method: 'POST' })
      expect(res.status).toBe(402)

      const body = await res.json()
      expect(body).toHaveProperty('macaroon')
      expect(body).toHaveProperty('payment_hash')
      expect(body.payment_hash).toBe('b'.repeat(64))
      expect(typeof body.macaroon).toBe('string')
      expect(body.macaroon.length).toBeGreaterThan(0)
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

    it('does not re-grant credits after they are fully spent', async () => {
      const { preimage, paymentHash } = makePreimageAndHash()
      const backend: LightningBackend = {
        createInvoice: vi.fn().mockResolvedValue({
          bolt11: 'lnbc100n1mock...',
          paymentHash,
        }),
        checkInvoice: vi.fn().mockResolvedValue({ paid: true, preimage }),
      }
      const app = createApp(backend, {
        freeTier: undefined,
        defaultInvoiceAmount: 4,
        pricing: { '/route': 2 },
      })

      const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 4)
      const authToken = `L402 ${macaroon}:${preimage}`

      const first = await app.request('/route', {
        method: 'POST',
        headers: { 'Authorization': authToken },
      })
      const second = await app.request('/route', {
        method: 'POST',
        headers: { 'Authorization': authToken },
      })
      const third = await app.request('/route', {
        method: 'POST',
        headers: { 'Authorization': authToken },
      })

      expect(first.status).not.toBe(402)
      expect(second.status).not.toBe(402)
      expect(third.status).toBe(402)
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

    it('accepts L402 token without valid preimage when invoice is settled (Cashu path)', async () => {
      const { preimage, paymentHash } = makePreimageAndHash()
      const backend: LightningBackend = {
        createInvoice: vi.fn().mockResolvedValue({
          bolt11: 'lnbc100n1mock...',
          paymentHash,
        }),
        checkInvoice: vi.fn(),
      }

      // Create app with shared meter so we can pre-settle the invoice
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const { CreditMeter } = await import('./meter.js')
      const meter = new CreditMeter(db)

      const app = new Hono()
      const booth = tollBooth({
        backend,
        pricing: { '/route': 2 },
        upstream: 'http://localhost:8002',
        rootKey: ROOT_KEY,
        freeTier: undefined,
        _meter: meter,
      })
      app.use('/*', booth)

      // Pre-settle the invoice (simulates Cashu redemption)
      meter.creditOnce(paymentHash, 1000)

      // Use "settled" as placeholder — no valid preimage
      const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
      const authToken = `L402 ${macaroon}:settled`

      const res = await app.request('/route', {
        method: 'POST',
        headers: { 'Authorization': authToken },
      })
      // Should proxy (502 because upstream is not running, but NOT 402)
      expect(res.status).not.toBe(402)
    })

    it('rejects L402 token with wrong preimage when invoice is NOT settled', async () => {
      const { paymentHash } = makePreimageAndHash()

      const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
      const authToken = `L402 ${macaroon}:not-a-preimage`

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

  describe('response headers', () => {
    it('includes configured responseHeaders on all responses', async () => {
      const app = createApp(mockBackend(), { responseHeaders: { 'X-Coverage': 'GB' } })
      const res = await app.request('/route', { method: 'POST' })
      expect(res.headers.get('X-Coverage')).toBe('GB')
    })

    it('omits extra headers when responseHeaders is not set', async () => {
      const app = createApp(mockBackend())
      const res = await app.request('/route', { method: 'POST' })
      expect(res.headers.get('X-Coverage')).toBeNull()
    })
  })

  describe('invoice storage', () => {
    it('stores invoice details on 402 when InvoiceStore is provided', async () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const invoiceStore = new InvoiceStore(db)

      const backend = mockBackend()
      const app = new Hono()
      const booth = tollBooth({
        backend,
        pricing: { '/route': 2 },
        upstream: 'http://localhost:8002',
        rootKey: ROOT_KEY,
        dbPath: ':memory:',
        _invoiceStore: invoiceStore,
      })
      app.use('/*', booth)

      const res = await app.request('/route', { method: 'POST' })
      expect(res.status).toBe(402)

      const body = await res.json()
      const stored = invoiceStore.get(body.payment_hash)
      expect(stored).toBeDefined()
      expect(stored!.bolt11).toBe('lnbc100n1mock...')
      expect(stored!.amountSats).toBe(1000)
    })

    it('includes payment_url in 402 response body', async () => {
      const backend = mockBackend()
      const app = createApp(backend, { freeTier: undefined })

      const res = await app.request('/route', { method: 'POST' })
      expect(res.status).toBe(402)

      const body = await res.json()
      expect(body.payment_url).toBe(`/invoice-status/${'b'.repeat(64)}`)
    })
  })

  describe('pricing lookup', () => {
    it('matches configured pricing when middleware is mounted under a prefix', async () => {
      const backend = mockBackend()
      const app = new Hono()
      const booth = tollBooth({
        backend,
        pricing: { '/route': 2 },
        upstream: 'http://localhost:8002',
        rootKey: ROOT_KEY,
        freeTier: undefined,
      })
      app.use('/api/*', booth)

      const res = await app.request('/api/route', { method: 'POST' })
      expect(res.status).toBe(402)
    })
  })
})
