// src/adapters/web-standard.test.ts
import { describe, it, expect, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createTollBooth } from '../core/toll-booth.js'
import { memoryStorage } from '../storage/memory.js'
import {
  createWebStandardMiddleware,
  createWebStandardCreateInvoiceHandler,
  createWebStandardInvoiceStatusHandler,
} from './web-standard.js'
import type { LightningBackend } from '../types.js'

const ROOT_KEY = randomBytes(32).toString('hex')

function mockBackend(): LightningBackend {
  return {
    createInvoice: vi.fn().mockResolvedValue({
      bolt11: 'lnbc100n1mock...',
      paymentHash: 'b'.repeat(64),
    }),
    checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
  }
}

describe('Web Standard adapter IP resolution', () => {
  it('uses getClientIp callback when provided', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: { '/route': 10 },
      upstream: 'http://localhost:8002',
      rootKey: ROOT_KEY,
      freeTier: { requestsPerDay: 2 },
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    )

    try {
      const handler = createWebStandardMiddleware({
        engine,
        upstream: 'http://upstream.test',
        getClientIp: () => '1.2.3.4',
      })

      const makeRequest = () => new Request('http://localhost/route', { method: 'POST' })

      const res1 = await handler(makeRequest())
      expect(res1.status).toBe(200)

      const res2 = await handler(makeRequest())
      expect(res2.status).toBe(200)

      const res3 = await handler(makeRequest())
      expect(res3.status).toBe(402)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('throws when freeTier enabled without trustProxy or getClientIp', () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: { '/route': 10 },
      upstream: 'http://localhost:8002',
      rootKey: ROOT_KEY,
      freeTier: { requestsPerDay: 5 },
    })

    expect(() => createWebStandardMiddleware({
      engine,
      upstream: 'http://localhost:8002',
    })).toThrow(/freeTier requires either trustProxy: true or getClientIp/)
  })
})

describe('Web Standard adapter', () => {
  it('returns 402 for priced routes without auth', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: { '/api/route': 10 },
      upstream: 'http://localhost:8002',
      rootKey: ROOT_KEY,
    })

    const handler = createWebStandardMiddleware(engine, 'http://localhost:8002')
    const res = await handler(new Request('http://localhost/api/route', { method: 'POST' }))

    expect(res.status).toBe(402)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = await res.json()
    const l402 = (body as any).l402
    expect(l402).toHaveProperty('invoice')
    expect(l402).toHaveProperty('macaroon')
    expect(l402).toHaveProperty('payment_hash')
    expect(body).toHaveProperty('message', 'Payment required.')
  })

  it('creates invoice via handler', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()

    const handler = createWebStandardCreateInvoiceHandler({
      backend,
      storage,
      rootKey: ROOT_KEY,
      tiers: [],
      defaultAmount: 1000,
    })

    const res = await handler(
      new Request('http://localhost/create-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = await res.json()
    expect(body).toHaveProperty('bolt11')
    expect(body).toHaveProperty('payment_hash')
    expect(body).toHaveProperty('amount_sats', 1000)
  })

  it('requires the invoice status token for JSON status checks', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const paymentHash = 'b'.repeat(64)
    storage.storeInvoice(paymentHash, 'lnbc100n1mock...', 1000, 'mac_token', 'status-token')

    const handler = createWebStandardInvoiceStatusHandler({ backend, storage })

    const missingToken = await handler(
      new Request(`http://localhost/invoice-status/${paymentHash}`, {
        headers: { Accept: 'application/json' },
      }),
    )
    expect(missingToken.status).toBe(404)

    const ok = await handler(
      new Request(`http://localhost/invoice-status/${paymentHash}?token=status-token`, {
        headers: { Accept: 'application/json' },
      }),
    )
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(ok.headers.get('vary')).toBe('Accept')
    expect(await ok.json()).toEqual({ paid: false })
  })

  it('returns 502 instead of throwing when upstream fetch fails', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: {},
      upstream: 'http://localhost:8002',
      rootKey: ROOT_KEY,
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'))

    try {
      const handler = createWebStandardMiddleware(engine, 'http://localhost:8002')
      const res = await handler(new Request('http://localhost/api/route', { method: 'POST' }))
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'Upstream unavailable' })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  describe('X-Toll-Cost reconciliation', () => {
    function makeEngine() {
      const backend = mockBackend()
      const storage = memoryStorage()
      return createTollBooth({
        backend,
        storage,
        pricing: { '/route': 10 },
        upstream: 'http://upstream.test',
        rootKey: ROOT_KEY,
      })
    }

    it('calls engine.reconcile when X-Toll-Cost header is present', async () => {
      const engine = makeEngine()

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: 'http://upstream.test',
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile').mockReturnValue({ adjusted: true, newBalance: 93, delta: 3 })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200, headers: { 'X-Toll-Cost': '7' } }),
      )

      try {
        const handler = createWebStandardMiddleware({ engine, upstream: 'http://upstream.test' })
        await handler(new Request('http://localhost/route', { method: 'GET' }))
        expect(reconcileSpy).toHaveBeenCalledWith('a'.repeat(64), 7)
      } finally {
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
        fetchSpy.mockRestore()
      }
    })

    it('does not call reconcile when X-Toll-Cost is absent', async () => {
      const engine = makeEngine()

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: 'http://upstream.test',
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile')
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      )

      try {
        const handler = createWebStandardMiddleware({ engine, upstream: 'http://upstream.test' })
        await handler(new Request('http://localhost/route', { method: 'GET' }))
        expect(reconcileSpy).not.toHaveBeenCalled()
      } finally {
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
        fetchSpy.mockRestore()
      }
    })

    it('updates X-Credit-Balance in response after reconciliation', async () => {
      const engine = makeEngine()

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: 'http://upstream.test',
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile').mockReturnValue({ adjusted: true, newBalance: 97, delta: 7 })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200, headers: { 'X-Toll-Cost': '3' } }),
      )

      try {
        const handler = createWebStandardMiddleware({ engine, upstream: 'http://upstream.test' })
        const res = await handler(new Request('http://localhost/route', { method: 'GET' }))
        expect(res.headers.get('x-credit-balance')).toBe('97')
      } finally {
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
        fetchSpy.mockRestore()
      }
    })

    it('ignores non-numeric X-Toll-Cost values', async () => {
      const engine = makeEngine()

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: 'http://upstream.test',
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile')
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200, headers: { 'X-Toll-Cost': 'banana' } }),
      )

      try {
        const handler = createWebStandardMiddleware({ engine, upstream: 'http://upstream.test' })
        const res = await handler(new Request('http://localhost/route', { method: 'GET' }))
        expect(res.status).toBe(200)
        expect(reconcileSpy).not.toHaveBeenCalled()
      } finally {
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
        fetchSpy.mockRestore()
      }
    })

    it('ignores negative X-Toll-Cost values', async () => {
      const engine = makeEngine()

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: 'http://upstream.test',
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile')
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200, headers: { 'X-Toll-Cost': '-5' } }),
      )

      try {
        const handler = createWebStandardMiddleware({ engine, upstream: 'http://upstream.test' })
        const res = await handler(new Request('http://localhost/route', { method: 'GET' }))
        expect(res.status).toBe(200)
        expect(reconcileSpy).not.toHaveBeenCalled()
      } finally {
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
        fetchSpy.mockRestore()
      }
    })

    it('handles zero X-Toll-Cost (free request)', async () => {
      const engine = makeEngine()

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: 'http://upstream.test',
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile').mockReturnValue({ adjusted: true, newBalance: 100, delta: 10 })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200, headers: { 'X-Toll-Cost': '0' } }),
      )

      try {
        const handler = createWebStandardMiddleware({ engine, upstream: 'http://upstream.test' })
        const res = await handler(new Request('http://localhost/route', { method: 'GET' }))
        expect(res.status).toBe(200)
        expect(reconcileSpy).toHaveBeenCalledWith('a'.repeat(64), 0)
        expect(res.headers.get('x-credit-balance')).toBe('100')
      } finally {
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
        fetchSpy.mockRestore()
      }
    })

    it('truncates fractional X-Toll-Cost values to integer', async () => {
      const engine = makeEngine()

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: 'http://upstream.test',
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile').mockReturnValue({ adjusted: true, newBalance: 95, delta: 5 })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200, headers: { 'X-Toll-Cost': '5.9' } }),
      )

      try {
        const handler = createWebStandardMiddleware({ engine, upstream: 'http://upstream.test' })
        const res = await handler(new Request('http://localhost/route', { method: 'GET' }))
        expect(res.status).toBe(200)
        // Fractional values like '5.9' are rejected by strict /^\d+$/ validation
        expect(reconcileSpy).not.toHaveBeenCalled()
      } finally {
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
        fetchSpy.mockRestore()
      }
    })

    it('ignores X-Toll-Cost values exceeding Number.MAX_SAFE_INTEGER', async () => {
      const engine = makeEngine()

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: 'http://upstream.test',
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile')
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200, headers: { 'X-Toll-Cost': '99999999999999999999' } }),
      )

      try {
        const handler = createWebStandardMiddleware({ engine, upstream: 'http://upstream.test' })
        const res = await handler(new Request('http://localhost/route', { method: 'GET' }))
        expect(res.status).toBe(200)
        expect(reconcileSpy).not.toHaveBeenCalled()
      } finally {
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
        fetchSpy.mockRestore()
      }
    })
  })

  describe('tier extraction', () => {
    it('extracts tier from query param', async () => {
      const backend = mockBackend()
      const storage = memoryStorage()
      const engine = createTollBooth({
        backend,
        storage,
        pricing: { '/route': { default: 10, premium: 25 } },
        upstream: 'http://upstream.test',
        rootKey: ROOT_KEY,
      })

      const handleSpy = vi.spyOn(engine, 'handle')
      handleSpy.mockResolvedValue({
        action: 'proxy',
        upstream: 'http://upstream.test',
        headers: { 'X-Toll-Tier': 'premium' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 25,
        creditBalance: 975,
        tier: 'premium',
      })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      )

      try {
        const handler = createWebStandardMiddleware(engine, 'http://upstream.test')
        const res = await handler(new Request('http://localhost/route?tier=premium', { method: 'GET' }))
        expect(res.status).toBe(200)
        expect(handleSpy).toHaveBeenCalledWith(
          expect.objectContaining({ tier: 'premium' }),
        )
      } finally {
        handleSpy.mockRestore()
        fetchSpy.mockRestore()
      }
    })

    it('falls back to X-Toll-Tier header when no query param', async () => {
      const backend = mockBackend()
      const storage = memoryStorage()
      const engine = createTollBooth({
        backend,
        storage,
        pricing: { '/route': { default: 10, premium: 25 } },
        upstream: 'http://upstream.test',
        rootKey: ROOT_KEY,
      })

      const handleSpy = vi.spyOn(engine, 'handle')
      handleSpy.mockResolvedValue({
        action: 'proxy',
        upstream: 'http://upstream.test',
        headers: { 'X-Toll-Tier': 'premium' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 25,
        creditBalance: 975,
        tier: 'premium',
      })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      )

      try {
        const handler = createWebStandardMiddleware(engine, 'http://upstream.test')
        const res = await handler(new Request('http://localhost/route', {
          method: 'GET',
          headers: { 'X-Toll-Tier': 'premium' },
        }))
        expect(res.status).toBe(200)
        expect(handleSpy).toHaveBeenCalledWith(
          expect.objectContaining({ tier: 'premium' }),
        )
      } finally {
        handleSpy.mockRestore()
        fetchSpy.mockRestore()
      }
    })

    it('forwards X-Toll-Tier header from engine result to response', async () => {
      const backend = mockBackend()
      const storage = memoryStorage()
      const engine = createTollBooth({
        backend,
        storage,
        pricing: { '/route': { default: 10, premium: 25 } },
        upstream: 'http://upstream.test',
        rootKey: ROOT_KEY,
      })

      const handleSpy = vi.spyOn(engine, 'handle')
      handleSpy.mockResolvedValue({
        action: 'proxy',
        upstream: 'http://upstream.test',
        headers: { 'X-Toll-Tier': 'premium' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 25,
        creditBalance: 975,
        tier: 'premium',
      })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 }),
      )

      try {
        const handler = createWebStandardMiddleware(engine, 'http://upstream.test')
        const res = await handler(new Request('http://localhost/route?tier=premium', { method: 'GET' }))
        expect(res.status).toBe(200)
        expect(res.headers.get('x-toll-tier')).toBe('premium')
      } finally {
        handleSpy.mockRestore()
        fetchSpy.mockRestore()
      }
    })
  })

  it('rejects oversized JSON bodies without reading them into memory', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()

    const handler = createWebStandardCreateInvoiceHandler({
      backend,
      storage,
      rootKey: ROOT_KEY,
      tiers: [],
      defaultAmount: 1000,
    })

    const oversizedBody = 'x'.repeat(70_000)
    const res = await handler(
      new Request('http://localhost/create-invoice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(oversizedBody.length),
        },
        body: oversizedBody,
      }),
    )

    expect(res.status).toBe(400)
  })
})
