// src/adapters/express.test.ts
import { describe, it, expect, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import express from 'express'
import { createTollBooth } from '../core/toll-booth.js'
import { memoryStorage } from '../storage/memory.js'
import { createExpressMiddleware, createExpressCreateInvoiceHandler } from './express.js'
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

    const body = await res.json()
    expect(body).toHaveProperty('invoice')
    expect(body).toHaveProperty('macaroon')
    expect(body).toHaveProperty('payment_hash')
    expect(body).toHaveProperty('error', 'Payment required')
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

    const body = await res.json()
    expect(body).toHaveProperty('bolt11')
    expect(body).toHaveProperty('payment_hash')
    expect(body).toHaveProperty('amount_sats', 1000)
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
})
