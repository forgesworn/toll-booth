// src/adapters/hono.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createHash, randomBytes } from 'node:crypto'
import { createHonoTollBooth, type TollBoothEnv } from './hono.js'
import { memoryStorage } from '../storage/memory.js'
import { createTollBooth } from '../core/toll-booth.js'
import { mintMacaroon } from '../macaroon.js'
import type { StorageBackend } from '../storage/interface.js'

// -- Helpers ------------------------------------------------------------------

function makeCredential(rootKey: string, creditSats = 1000) {
  const preimage = randomBytes(32).toString('hex')
  const paymentHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex')
  const macaroon = mintMacaroon(rootKey, paymentHash, creditSats)
  return { preimage, paymentHash, macaroon }
}

function createTestEngine(overrides?: Partial<Parameters<typeof createTollBooth>[0]>) {
  const rootKey = 'a'.repeat(64)
  const storage = memoryStorage()
  const engine = createTollBooth({
    rootKey,
    storage,
    upstream: 'http://upstream.test',
    pricing: { '/api/test': 10 },
    defaultInvoiceAmount: 1000,
    ...overrides,
  })
  return { engine, storage, rootKey }
}

// -- Tests --------------------------------------------------------------------

describe('createHonoTollBooth', () => {
  it('passes through authenticated request and sets context variables', async () => {
    const { engine, storage, rootKey } = createTestEngine()
    const { authMiddleware } = createHonoTollBooth({ engine })

    const { preimage, paymentHash, macaroon } = makeCredential(rootKey, 1000)
    // Settle the invoice so the credential is valid
    storage.settleWithCredit(paymentHash, 1000, preimage)

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => {
      return c.json({
        action: c.get('tollBoothAction'),
        paymentHash: c.get('tollBoothPaymentHash'),
        creditBalance: c.get('tollBoothCreditBalance'),
      })
    })

    const res = await app.request('/api/test', {
      headers: { Authorization: `L402 ${macaroon}:${preimage}` },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.action).toBe('proxy')
    expect(body.paymentHash).toBe(paymentHash)
    expect(typeof body.creditBalance).toBe('number')
  })

  it('returns 402 challenge when no auth header is present', async () => {
    const { engine } = createTestEngine()
    const { authMiddleware } = createHonoTollBooth({ engine })

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => c.text('ok'))

    const res = await app.request('/api/test')

    expect(res.status).toBe(402)
    const body = await res.json() as Record<string, unknown>
    const l402 = (body as any).l402
    expect(l402).toHaveProperty('payment_hash')
    expect(l402).toHaveProperty('macaroon')
    expect(body.message).toBe('Payment required.')
    expect(res.headers.get('www-authenticate')).toMatch(/^L402 macaroon="/)
  })

  it('passes through free-tier request and sets action to proxy', async () => {
    const { engine } = createTestEngine({
      freeTier: { requestsPerDay: 5 },
    })
    const { authMiddleware } = createHonoTollBooth({ engine })

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => {
      return c.json({ action: c.get('tollBoothAction') })
    })

    const res = await app.request('/api/test', {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.action).toBe('proxy')
  })

  it('passes through unpriced route without auth (action = pass)', async () => {
    const { engine } = createTestEngine()
    const { authMiddleware } = createHonoTollBooth({ engine })

    const app = new Hono<TollBoothEnv>()
    app.use('/health', authMiddleware)
    app.get('/health', (c) => {
      return c.json({ action: c.get('tollBoothAction') })
    })

    const res = await app.request('/health')

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.action).toBe('pass')
  })

  it('invokes custom getClientIp callback for IP resolution', async () => {
    const { engine } = createTestEngine()
    const getClientIp = vi.fn().mockReturnValue('5.6.7.8')
    const { authMiddleware } = createHonoTollBooth({ engine, getClientIp })

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => c.text('ok'))

    // The request will issue a 402 (no auth) but getClientIp should be called
    await app.request('/api/test')

    expect(getClientIp).toHaveBeenCalledOnce()
  })

  it('returns 402 for invalid L402 credentials', async () => {
    const { engine } = createTestEngine()
    const { authMiddleware } = createHonoTollBooth({ engine })

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => c.text('ok'))

    const res = await app.request('/api/test', {
      headers: { Authorization: 'L402 invalid:credentials' },
    })

    expect(res.status).toBe(402)
    const body = await res.json() as Record<string, unknown>
    expect(body.message).toBe('Payment required.')
  })
})

describe('Hono adapter tier extraction', () => {
  it('extracts tier from query param', async () => {
    const { engine } = createTestEngine({
      pricing: { '/api/test': { default: 10, premium: 25 } },
    })
    const handleSpy = vi.spyOn(engine, 'handle')
    const { authMiddleware } = createHonoTollBooth({ engine })

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => c.json({ tier: c.get('tollBoothTier') }))

    // Mock to return a proxy result with tier set
    handleSpy.mockResolvedValue({
      action: 'proxy',
      upstream: 'http://upstream.test',
      headers: { 'X-Toll-Tier': 'premium' },
      paymentHash: 'a'.repeat(64),
      estimatedCost: 25,
      creditBalance: 975,
      tier: 'premium',
    })

    const res = await app.request('/api/test?tier=premium')
    expect(res.status).toBe(200)
    expect(handleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'premium' }),
    )
    const body = await res.json() as Record<string, unknown>
    expect(body.tier).toBe('premium')

    handleSpy.mockRestore()
  })

  it('falls back to X-Toll-Tier header when no query param', async () => {
    const { engine } = createTestEngine({
      pricing: { '/api/test': { default: 10, premium: 25 } },
    })
    const handleSpy = vi.spyOn(engine, 'handle')
    const { authMiddleware } = createHonoTollBooth({ engine })

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => c.json({ tier: c.get('tollBoothTier') }))

    handleSpy.mockResolvedValue({
      action: 'proxy',
      upstream: 'http://upstream.test',
      headers: { 'X-Toll-Tier': 'premium' },
      paymentHash: 'a'.repeat(64),
      estimatedCost: 25,
      creditBalance: 975,
      tier: 'premium',
    })

    const res = await app.request('/api/test', {
      headers: { 'X-Toll-Tier': 'premium' },
    })
    expect(res.status).toBe(200)
    expect(handleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'premium' }),
    )

    handleSpy.mockRestore()
  })

  it('sets tollBoothTier context variable from engine result', async () => {
    const { engine } = createTestEngine({
      pricing: { '/api/test': { default: 10, premium: 25 } },
    })
    const handleSpy = vi.spyOn(engine, 'handle')
    const { authMiddleware } = createHonoTollBooth({ engine })

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => {
      return c.json({ tier: c.get('tollBoothTier') })
    })

    handleSpy.mockResolvedValue({
      action: 'proxy',
      upstream: 'http://upstream.test',
      headers: { 'X-Toll-Tier': 'premium' },
      paymentHash: 'a'.repeat(64),
      estimatedCost: 25,
      creditBalance: 975,
      tier: 'premium',
    })

    const res = await app.request('/api/test?tier=premium')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.tier).toBe('premium')

    handleSpy.mockRestore()
  })
})

// -- Helpers for payment route tests ------------------------------------------

function createPaymentTestApp(storage: StorageBackend, rootKey: string) {
  const { engine } = createTestEngine()
  const tollBooth = createHonoTollBooth({ engine })
  const paymentApp = tollBooth.createPaymentApp({
    storage,
    rootKey,
    tiers: [],
    defaultAmount: 1000,
  })
  const app = new Hono()
  app.route('/', paymentApp)
  return app
}

describe('Hono payment routes', () => {
  it('POST /create-invoice creates an invoice', async () => {
    const { storage, rootKey } = createTestEngine()
    const app = createPaymentTestApp(storage, rootKey)

    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('payment_hash')
    expect(body).toHaveProperty('macaroon')
    expect(typeof body.payment_hash).toBe('string')
    expect(typeof body.macaroon).toBe('string')
  })

  it('GET /invoice-status/:hash returns invoice status', async () => {
    const { storage, rootKey } = createTestEngine()
    const app = createPaymentTestApp(storage, rootKey)

    // Create invoice first
    const createRes = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(createRes.status).toBe(200)
    const created = await createRes.json() as Record<string, unknown>
    const paymentUrl = created.payment_url as string

    // Check status via payment_url (strip leading slash for routing)
    const statusRes = await app.request(paymentUrl)
    expect(statusRes.status).toBe(200)
    const statusBody = await statusRes.json() as Record<string, unknown>
    expect(statusBody).toHaveProperty('paid')
    expect(statusBody.paid).toBe(false)
  })

  it('GET /invoice-status/:hash returns HTML when Accept: text/html', async () => {
    const { storage, rootKey } = createTestEngine()
    const app = createPaymentTestApp(storage, rootKey)

    // Create invoice first
    const createRes = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(createRes.status).toBe(200)
    const created = await createRes.json() as Record<string, unknown>
    const paymentUrl = created.payment_url as string

    const statusRes = await app.request(paymentUrl, {
      headers: { Accept: 'text/html' },
    })
    expect(statusRes.status).toBe(200)
    const contentType = statusRes.headers.get('content-type') ?? ''
    expect(contentType).toContain('text/html')
  })

  it('GET /invoice-status/:hash returns 404 for unknown invoice', async () => {
    const { storage, rootKey } = createTestEngine()
    const app = createPaymentTestApp(storage, rootKey)

    const unknownHash = 'a'.repeat(64)
    const res = await app.request(`/invoice-status/${unknownHash}`)
    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('error')
  })
})

describe('Hono adapter integration', () => {
  it('full L402 flow: create invoice -> settle -> authenticated request', async () => {
    const { engine, storage, rootKey } = createTestEngine()
    const tollBooth = createHonoTollBooth({ engine })
    const app = new Hono<TollBoothEnv>()

    const paymentApp = tollBooth.createPaymentApp({
      storage,
      rootKey,
      tiers: [],
      defaultAmount: 1000,
    })
    app.route('/', paymentApp)
    app.use('/api/*', tollBooth.authMiddleware)
    app.get('/api/test', (c) => {
      return c.json({
        paymentHash: c.get('tollBoothPaymentHash'),
        creditBalance: c.get('tollBoothCreditBalance'),
      })
    })

    // Step 1: Request without auth -> 402
    const unauthRes = await app.request('/api/test')
    expect(unauthRes.status).toBe(402)
    const challenge = await unauthRes.json() as Record<string, unknown>
    const challengeL402 = (challenge as any).l402
    expect(challengeL402).toHaveProperty('payment_hash')
    expect(challengeL402).toHaveProperty('macaroon')

    // Step 2: Create invoice via payment route
    const createRes = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(createRes.status).toBe(200)
    const invoice = await createRes.json() as Record<string, unknown>
    const paymentHash = invoice.payment_hash as string

    // Step 3: Settle payment directly in storage (simulate Lightning payment)
    const preimage = randomBytes(32).toString('hex')
    storage.settleWithCredit(paymentHash, 1000, preimage)

    // Step 4: Get the macaroon from challenge (or use the one from create-invoice)
    const macaroon = invoice.macaroon as string

    // Step 5: Authenticated request
    const authRes = await app.request('/api/test', {
      headers: { Authorization: `L402 ${macaroon}:${preimage}` },
    })
    expect(authRes.status).toBe(200)
    const body = await authRes.json() as Record<string, unknown>
    expect(body.paymentHash).toBe(paymentHash)
    expect(typeof body.creditBalance).toBe('number')
  })

  it('reconcile adjusts balance after authenticated request', async () => {
    const { engine, storage, rootKey } = createTestEngine()
    const { preimage, paymentHash, macaroon } = makeCredential(rootKey)
    storage.settleWithCredit(paymentHash, 1000, preimage)

    const tollBooth = createHonoTollBooth({ engine })
    const app = new Hono<TollBoothEnv>()
    app.use('/api/*', tollBooth.authMiddleware)
    app.get('/api/test', (c) => {
      // Simulate upstream returning actual cost of 5 (estimated was 10)
      const ph = c.get('tollBoothPaymentHash')
      if (ph) {
        const result = tollBooth.engine.reconcile(ph, 5)
        return c.json({ adjusted: result.adjusted, newBalance: result.newBalance })
      }
      return c.json({ adjusted: false })
    })

    const res = await app.request('/api/test', {
      headers: { Authorization: `L402 ${macaroon}:${preimage}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.adjusted).toBe(true)
    expect(body.newBalance).toBe(995) // 1000 - 10 (estimated) + 5 (refund)
  })
})
