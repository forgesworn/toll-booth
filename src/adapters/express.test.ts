// src/adapters/express.test.ts
import { describe, it, expect, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import express from 'express'
import { createTollBooth } from '../core/toll-booth.js'
import { memoryStorage } from '../storage/memory.js'
import {
  createExpressMiddleware,
  createExpressCreateInvoiceHandler,
  createExpressInvoiceStatusHandler,
} from './express.js'
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

async function request(app: express.Express, path: string, options: RequestInit = {}): Promise<Response> {
  const { createServer } = await import('node:http')
  return new Promise((resolve, reject) => {
    const server = createServer(app)
    server.listen(0, () => {
      const addr = server.address() as { port: number }
      fetch(`http://127.0.0.1:${addr.port}${path}`, options)
        .then(resolve)
        .catch(reject)
        .finally(() => server.close())
    })
  })
}

async function requestRaw(app: express.Express, requestText: string): Promise<string> {
  const { createServer } = await import('node:http')
  const { once } = await import('node:events')
  const { default: net } = await import('node:net')

  const server = createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  try {
    const { port } = server.address() as { port: number }
    const socket = net.connect(port, '127.0.0.1')
    let response = ''

    socket.write(requestText)
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8')
    })
    await once(socket, 'end')
    return response
  } finally {
    server.close()
  }
}

describe('Express adapter', () => {
  it('returns 402 for priced routes without auth', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: { '/route': 10 },
      upstream: 'http://localhost:8002',
      rootKey: ROOT_KEY,
    })

    const app = express()
    app.use('/route', createExpressMiddleware(engine, 'http://localhost:8002'))

    const res = await request(app, '/route', { method: 'POST' })
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

    const app = express()
    app.use(express.json())
    app.post(
      '/create-invoice',
      createExpressCreateInvoiceHandler({
        backend,
        storage,
        rootKey: ROOT_KEY,
        tiers: [],
        defaultAmount: 1000,
      }),
    )

    const res = await request(app, '/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
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

    const app = express()
    app.get(
      '/invoice-status/:paymentHash',
      createExpressInvoiceStatusHandler({ backend, storage }),
    )

    const missingToken = await request(app, `/invoice-status/${paymentHash}`, {
      headers: { Accept: 'application/json' },
    })
    expect(missingToken.status).toBe(404)

    const ok = await request(app, `/invoice-status/${paymentHash}?token=status-token`, {
      headers: { Accept: 'application/json' },
    })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(ok.headers.get('vary')).toBe('Accept')
    expect(await ok.json()).toEqual({ paid: false })
  })

  it('forwards parsed POST body to upstream when express.json() is mounted', async () => {
    const { createServer } = await import('node:http')

    // Upstream echo server — returns the received body
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(Buffer.concat(chunks))
      })
    })
    await new Promise<void>((r) => upstream.listen(0, r))
    const upstreamPort = (upstream.address() as { port: number }).port

    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: {},  // no priced routes — everything passes through
      upstream: `http://127.0.0.1:${upstreamPort}`,
      rootKey: ROOT_KEY,
    })

    const app = express()
    app.use(express.json())  // body parser before middleware
    app.use('/api', createExpressMiddleware(engine, `http://127.0.0.1:${upstreamPort}`))

    try {
      const payload = { hello: 'world' }
      const res = await request(app, '/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(payload)
    } finally {
      upstream.close()
    }
  })

  describe('X-Toll-Cost reconciliation', () => {
    function makeEngine() {
      const backend = mockBackend()
      const storage = memoryStorage()
      const engine = createTollBooth({
        backend,
        storage,
        pricing: { '/route': 10 },
        upstream: 'http://127.0.0.1:0',
        rootKey: ROOT_KEY,
      })
      return engine
    }

    /**
     * Creates a real upstream HTTP server that responds with `X-Toll-Cost` set
     * to `tollCost` (or omits it when `tollCost` is undefined).
     */
    async function makeUpstream(tollCost?: string): Promise<{ port: number; close: () => void }> {
      const { createServer: createHttpServer } = await import('node:http')
      const upstream = createHttpServer((_req, res) => {
        const headers: Record<string, string> = { 'Content-Type': 'text/plain' }
        if (tollCost !== undefined) headers['X-Toll-Cost'] = tollCost
        res.writeHead(200, headers)
        res.end('ok')
      })
      await new Promise<void>((r) => upstream.listen(0, r))
      const port = (upstream.address() as { port: number }).port
      return { port, close: () => upstream.close() }
    }

    it('calls engine.reconcile when X-Toll-Cost header is present', async () => {
      const engine = makeEngine()
      const upstream = await makeUpstream('7')

      // Mock handle to return an authenticated proxy result with a known paymentHash.
      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: `http://127.0.0.1:${upstream.port}`,
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile').mockReturnValue({ adjusted: true, newBalance: 93, delta: 3 })

      const app = express()
      app.use('/route', createExpressMiddleware({ engine, upstream: `http://127.0.0.1:${upstream.port}` }))

      try {
        await request(app, '/route', { method: 'GET' })
        expect(reconcileSpy).toHaveBeenCalledWith('a'.repeat(64), 7)
      } finally {
        upstream.close()
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
      }
    })

    it('does not call reconcile when X-Toll-Cost is absent', async () => {
      const engine = makeEngine()
      const upstream = await makeUpstream(/* no toll cost */)

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: `http://127.0.0.1:${upstream.port}`,
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile')

      const app = express()
      app.use('/route', createExpressMiddleware({ engine, upstream: `http://127.0.0.1:${upstream.port}` }))

      try {
        await request(app, '/route', { method: 'GET' })
        expect(reconcileSpy).not.toHaveBeenCalled()
      } finally {
        upstream.close()
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
      }
    })

    it('updates X-Credit-Balance in response after reconciliation', async () => {
      const engine = makeEngine()
      const upstream = await makeUpstream('3')

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: `http://127.0.0.1:${upstream.port}`,
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile').mockReturnValue({ adjusted: true, newBalance: 97, delta: 7 })

      const app = express()
      app.use('/route', createExpressMiddleware({ engine, upstream: `http://127.0.0.1:${upstream.port}` }))

      try {
        const res = await request(app, '/route', { method: 'GET' })
        expect(res.headers.get('x-credit-balance')).toBe('97')
      } finally {
        upstream.close()
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
      }
    })

    it('ignores non-numeric X-Toll-Cost values', async () => {
      const engine = makeEngine()
      const upstream = await makeUpstream('banana')

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: `http://127.0.0.1:${upstream.port}`,
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile')

      const app = express()
      app.use('/route', createExpressMiddleware({ engine, upstream: `http://127.0.0.1:${upstream.port}` }))

      try {
        const res = await request(app, '/route', { method: 'GET' })
        expect(res.status).toBe(200)
        expect(reconcileSpy).not.toHaveBeenCalled()
      } finally {
        upstream.close()
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
      }
    })

    it('ignores negative X-Toll-Cost values', async () => {
      const engine = makeEngine()
      const upstream = await makeUpstream('-5')

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: `http://127.0.0.1:${upstream.port}`,
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile')

      const app = express()
      app.use('/route', createExpressMiddleware({ engine, upstream: `http://127.0.0.1:${upstream.port}` }))

      try {
        const res = await request(app, '/route', { method: 'GET' })
        expect(res.status).toBe(200)
        expect(reconcileSpy).not.toHaveBeenCalled()
      } finally {
        upstream.close()
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
      }
    })

    it('handles zero X-Toll-Cost (free request)', async () => {
      const engine = makeEngine()
      const upstream = await makeUpstream('0')

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: `http://127.0.0.1:${upstream.port}`,
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile').mockReturnValue({ adjusted: true, newBalance: 100, delta: 10 })

      const app = express()
      app.use('/route', createExpressMiddleware({ engine, upstream: `http://127.0.0.1:${upstream.port}` }))

      try {
        const res = await request(app, '/route', { method: 'GET' })
        expect(res.status).toBe(200)
        expect(reconcileSpy).toHaveBeenCalledWith('a'.repeat(64), 0)
        expect(res.headers.get('x-credit-balance')).toBe('100')
      } finally {
        upstream.close()
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
      }
    })

    it('truncates fractional X-Toll-Cost values to integer', async () => {
      const engine = makeEngine()
      const upstream = await makeUpstream('5.9')

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: `http://127.0.0.1:${upstream.port}`,
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile').mockReturnValue({ adjusted: true, newBalance: 95, delta: 5 })

      const app = express()
      app.use('/route', createExpressMiddleware({ engine, upstream: `http://127.0.0.1:${upstream.port}` }))

      try {
        const res = await request(app, '/route', { method: 'GET' })
        expect(res.status).toBe(200)
        // Fractional values like '5.9' are rejected by strict /^\d+$/ validation
        expect(reconcileSpy).not.toHaveBeenCalled()
      } finally {
        upstream.close()
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
      }
    })

    it('ignores X-Toll-Cost values exceeding Number.MAX_SAFE_INTEGER', async () => {
      const engine = makeEngine()
      const upstream = await makeUpstream('99999999999999999999')

      const handleSpy = vi.spyOn(engine, 'handle').mockResolvedValue({
        action: 'proxy',
        upstream: `http://127.0.0.1:${upstream.port}`,
        headers: { 'X-Credit-Balance': '90' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 10,
        creditBalance: 90,
      })
      const reconcileSpy = vi.spyOn(engine, 'reconcile')

      const app = express()
      app.use('/route', createExpressMiddleware({ engine, upstream: `http://127.0.0.1:${upstream.port}` }))

      try {
        const res = await request(app, '/route', { method: 'GET' })
        expect(res.status).toBe(200)
        expect(reconcileSpy).not.toHaveBeenCalled()
      } finally {
        upstream.close()
        handleSpy.mockRestore()
        reconcileSpy.mockRestore()
      }
    })
  })

  describe('tier extraction', () => {
    async function makeUpstreamRecordingTier(): Promise<{
      port: number
      close: () => void
      receivedHeaders: () => Record<string, string | undefined>
    }> {
      const { createServer: createHttpServer } = await import('node:http')
      let lastHeaders: Record<string, string | undefined> = {}
      const upstream = createHttpServer((req, res) => {
        lastHeaders = {}
        for (const [key, value] of Object.entries(req.headers)) {
          lastHeaders[key] = Array.isArray(value) ? value[0] : value
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
      })
      await new Promise<void>((r) => upstream.listen(0, r))
      const port = (upstream.address() as { port: number }).port
      return { port, close: () => upstream.close(), receivedHeaders: () => lastHeaders }
    }

    it('extracts tier from query param', async () => {
      const backend = mockBackend()
      const storage = memoryStorage()
      const engine = createTollBooth({
        backend,
        storage,
        pricing: { '/route': { default: 10, premium: 25 } },
        upstream: 'http://127.0.0.1:0',
        rootKey: ROOT_KEY,
      })

      const handleSpy = vi.spyOn(engine, 'handle')
      const upstream = await makeUpstreamRecordingTier()

      // Mock handle to return a pass-through proxy result
      handleSpy.mockResolvedValue({
        action: 'proxy',
        upstream: `http://127.0.0.1:${upstream.port}`,
        headers: { 'X-Toll-Tier': 'premium' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 25,
        creditBalance: 975,
        tier: 'premium',
      })

      const app = express()
      app.use('/route', createExpressMiddleware({ engine, upstream: `http://127.0.0.1:${upstream.port}` }))

      try {
        const res = await request(app, '/route?tier=premium', { method: 'GET' })
        expect(res.status).toBe(200)
        expect(handleSpy).toHaveBeenCalledWith(
          expect.objectContaining({ tier: 'premium' }),
        )
      } finally {
        upstream.close()
        handleSpy.mockRestore()
      }
    })

    it('falls back to X-Toll-Tier header when no query param', async () => {
      const backend = mockBackend()
      const storage = memoryStorage()
      const engine = createTollBooth({
        backend,
        storage,
        pricing: { '/route': { default: 10, premium: 25 } },
        upstream: 'http://127.0.0.1:0',
        rootKey: ROOT_KEY,
      })

      const handleSpy = vi.spyOn(engine, 'handle')
      const upstream = await makeUpstreamRecordingTier()

      handleSpy.mockResolvedValue({
        action: 'proxy',
        upstream: `http://127.0.0.1:${upstream.port}`,
        headers: { 'X-Toll-Tier': 'premium' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 25,
        creditBalance: 975,
        tier: 'premium',
      })

      const app = express()
      app.use('/route', createExpressMiddleware({ engine, upstream: `http://127.0.0.1:${upstream.port}` }))

      try {
        const res = await request(app, '/route', {
          method: 'GET',
          headers: { 'X-Toll-Tier': 'premium' },
        })
        expect(res.status).toBe(200)
        expect(handleSpy).toHaveBeenCalledWith(
          expect.objectContaining({ tier: 'premium' }),
        )
      } finally {
        upstream.close()
        handleSpy.mockRestore()
      }
    })

    it('forwards X-Toll-Tier header from engine result to upstream', async () => {
      const backend = mockBackend()
      const storage = memoryStorage()
      const engine = createTollBooth({
        backend,
        storage,
        pricing: { '/route': { default: 10, premium: 25 } },
        upstream: 'http://127.0.0.1:0',
        rootKey: ROOT_KEY,
      })

      const handleSpy = vi.spyOn(engine, 'handle')
      const upstream = await makeUpstreamRecordingTier()

      handleSpy.mockResolvedValue({
        action: 'proxy',
        upstream: `http://127.0.0.1:${upstream.port}`,
        headers: { 'X-Toll-Tier': 'premium' },
        paymentHash: 'a'.repeat(64),
        estimatedCost: 25,
        creditBalance: 975,
        tier: 'premium',
      })

      const app = express()
      app.use('/route', createExpressMiddleware({ engine, upstream: `http://127.0.0.1:${upstream.port}` }))

      try {
        const res = await request(app, '/route?tier=premium', { method: 'GET' })
        expect(res.status).toBe(200)
        // The engine result headers are set on the client response
        expect(res.headers.get('x-toll-tier')).toBe('premium')
      } finally {
        upstream.close()
        handleSpy.mockRestore()
      }
    })
  })

  it('does not allow absolute-form request targets to override the configured upstream host', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: {},
      upstream: 'http://127.0.0.1:8002',
      rootKey: ROOT_KEY,
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    )

    const app = express()
    app.use(createExpressMiddleware(engine, 'http://127.0.0.1:8002'))

    try {
      await requestRaw(
        app,
        'GET http://evil.test/pwn?x=1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
      )

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8002/pwn?x=1',
        expect.any(Object),
      )
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
