// src/demo.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { memoryStorage } from './storage/memory.js'
import { createTollBooth } from './core/toll-booth.js'
import {
  createWebStandardMiddleware,
  createWebStandardCreateInvoiceHandler,
  createWebStandardInvoiceStatusHandler,
} from './adapters/web-standard.js'
import type { LightningBackend, Invoice, InvoiceStatus } from './types.js'
import type { StorageBackend } from './storage/interface.js'

// -- Helpers (same patterns as demo.ts) ---------------------------------------

function createMockBackend(storage: StorageBackend): LightningBackend {
  return {
    async createInvoice(amountSats: number, _memo?: string): Promise<Invoice> {
      const preimage = randomBytes(32)
      const paymentHash = createHash('sha256').update(preimage).digest('hex')
      const bolt11 = `lnbc${amountSats}n1demo${randomBytes(20).toString('hex')}`
      // Settle immediately for tests (no setTimeout)
      storage.settleWithCredit(paymentHash, amountSats, preimage.toString('hex'))
      return { bolt11, paymentHash }
    },
    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      return { paid: storage.isSettled(paymentHash), preimage: storage.getSettlementSecret(paymentHash) }
    },
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>
}

// -- Functional demo server for tests -----------------------------------------

function startTestDemoServer(): Promise<{ port: number; server: Server; upstreamServer: Server }> {
  return new Promise((resolve) => {
    const storage = memoryStorage()
    const backend = createMockBackend(storage)
    const rootKey = randomBytes(32).toString('hex')

    // Upstream joke API
    const jokes = [{ setup: 'Test joke', punchline: 'Test punchline' }]
    const upstreamServer = createServer((req, res) => {
      if (req.url?.startsWith('/api/joke')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(jokes[0]))
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
      }
    })

    upstreamServer.listen(0, () => {
      const upstreamAddr = upstreamServer.address()
      const upstreamPort = typeof upstreamAddr === 'object' && upstreamAddr ? upstreamAddr.port : 0
      const upstreamUrl = `http://localhost:${upstreamPort}`

      const engine = createTollBooth({
        backend,
        storage,
        rootKey,
        upstream: upstreamUrl,
        pricing: { '/api/joke': 10 },
        defaultInvoiceAmount: 10,
        freeTier: { requestsPerDay: 2 },
      })

      const middleware = createWebStandardMiddleware({
        engine,
        upstream: upstreamUrl,
        getClientIp: () => '127.0.0.1',
      })

      const createInvoiceHandler = createWebStandardCreateInvoiceHandler({
        backend, storage, rootKey, tiers: [], defaultAmount: 10,
      })

      const invoiceStatusHandler = createWebStandardInvoiceStatusHandler({
        backend, storage,
      })

      const server = createServer((nodeReq, nodeRes) => {
        const chunks: Buffer[] = []
        nodeReq.on('data', (chunk: Buffer) => chunks.push(chunk))
        nodeReq.on('end', () => {
          const body = Buffer.concat(chunks)
          const host = nodeReq.headers.host ?? 'localhost'
          const url = new URL(nodeReq.url ?? '/', `http://${host}`)
          const headers = new Headers()
          for (const [key, value] of Object.entries(nodeReq.headers)) {
            if (value !== undefined) {
              headers.set(key, Array.isArray(value) ? value.join(', ') : value)
            }
          }
          const init: RequestInit = { method: nodeReq.method, headers }
          if (nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD' && body.length > 0) {
            init.body = body
          }
          const webReq = new Request(url, init)
          const pathname = url.pathname

          void (async () => {
            try {
              let response: Response
              if (pathname === '/create-invoice' && nodeReq.method === 'POST') {
                response = await createInvoiceHandler(webReq)
              } else if (pathname.startsWith('/invoice-status/') && nodeReq.method === 'GET') {
                response = await invoiceStatusHandler(webReq)
              } else {
                response = await middleware(webReq)
              }
              nodeRes.statusCode = response.status
              for (const [key, value] of response.headers.entries()) {
                nodeRes.setHeader(key, value)
              }
              if (response.body) {
                const reader = response.body.getReader()
                try {
                  while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    nodeRes.write(value)
                  }
                } finally {
                  reader.releaseLock()
                }
              }
              nodeRes.end()
            } catch {
              nodeRes.statusCode = 500
              nodeRes.end('Internal server error')
            }
          })()
        })
      })

      server.listen(0, () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({ port, server, upstreamServer })
      })
    })
  })
}

// -- Tests --------------------------------------------------------------------

describe('demo server', () => {
  let port: number
  let server: Server
  let upstreamServer: Server

  afterAll(() => {
    server?.close()
    upstreamServer?.close()
  })

  it('starts and serves jokes via free tier', async () => {
    const result = await startTestDemoServer()
    port = result.port
    server = result.server
    upstreamServer = result.upstreamServer

    const res = await fetch(`http://localhost:${port}/api/joke`)
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body).toHaveProperty('setup')
    expect(body).toHaveProperty('punchline')
  })

  it('returns 402 after free tier is exhausted', async () => {
    // First request already consumed one free request above
    // Second free request
    const res2 = await fetch(`http://localhost:${port}/api/joke`)
    expect(res2.status).toBe(200)

    // Third request should be 402 (free tier was 2)
    const res3 = await fetch(`http://localhost:${port}/api/joke`)
    expect(res3.status).toBe(402)
    const body = await readJson(res3)
    expect(body).toHaveProperty('macaroon')
    expect(body).toHaveProperty('invoice')
    expect(body).toHaveProperty('payment_hash')
    expect(body).toHaveProperty('payment_url')
    expect(body.amount_sats).toBe(10)
  })

  it('accepts L402 authorisation after payment', async () => {
    // Create an invoice
    const invoiceRes = await fetch(`http://localhost:${port}/create-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(invoiceRes.status).toBe(200)
    const invoice = await readJson(invoiceRes) as {
      macaroon: string
      payment_hash: string
      payment_url: string
    }
    expect(invoice).toHaveProperty('macaroon')
    expect(invoice).toHaveProperty('payment_hash')

    // Mock backend auto-settles; check invoice status
    const statusUrl = `http://localhost:${port}${invoice.payment_url}`
    const statusRes = await fetch(statusUrl)
    expect(statusRes.status).toBe(200)
    const status = await readJson(statusRes) as { paid: boolean; preimage: string }
    expect(status.paid).toBe(true)
    expect(status.preimage).toBeTruthy()

    // Use L402 token to access gated endpoint
    const token = `${invoice.macaroon}:${status.preimage}`
    const gatedRes = await fetch(`http://localhost:${port}/api/joke`, {
      headers: { Authorization: `L402 ${token}` },
    })
    expect(gatedRes.status).toBe(200)
    const joke = await readJson(gatedRes)
    expect(joke).toHaveProperty('setup', 'Test joke')
  })

  it('returns 404 for unknown upstream routes', async () => {
    const res = await fetch(`http://localhost:${port}/nonexistent`)
    // Unpriced route passes through to upstream, which returns 404
    expect(res.status).toBe(404)
  })
})
