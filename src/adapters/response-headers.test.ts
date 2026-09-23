// src/adapters/response-headers.test.ts
//
// Engine result headers that are meant for the client (an IETF Payment
// session token, balances, receipts) must reach the client through every
// adapter, and must never be forwarded to the upstream.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import express from 'express'
import { Hono } from 'hono'
import { createTollBooth, type TollBoothEngine } from '../core/toll-booth.js'
import { createIETFSessionRail } from '../core/ietf-session.js'
import { createIETFPaymentRail } from '../core/ietf-payment.js'
import { memoryStorage } from '../storage/memory.js'
import { createExpressMiddleware } from './express.js'
import { createWebStandardMiddleware } from './web-standard.js'
import { createHonoTollBooth, type TollBoothEnv } from './hono.js'
import type { LightningBackend } from '../types.js'

const ROOT_KEY = randomBytes(32).toString('hex')
const HMAC_SECRET = randomBytes(32).toString('hex')
const REALM = 'test.example.com'
/** BOLT-11 spec vector: an amountless mainnet invoice. */
const AMOUNTLESS_INVOICE = 'lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w'

let upstream: Server
let upstreamUrl: string
const upstreamSeen: IncomingHttpHeaders[] = []

beforeAll(async () => {
  upstream = createServer((req, res) => {
    upstreamSeen.push(req.headers)
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
})

afterAll(async () => {
  upstream.close()
  await once(upstream, 'close')
})

function sessionEngine(chargeRailFirst = false): { engine: TollBoothEngine; openCredential: () => Promise<string> } {
  const invoices = new Map<string, string>()
  const backend: LightningBackend = {
    async createInvoice() {
      const preimage = randomBytes(32).toString('hex')
      const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
      invoices.set(paymentHash, preimage)
      return { bolt11: `lnbc1test${paymentHash.slice(0, 16)}`, paymentHash }
    },
    async checkInvoice(paymentHash: string) {
      const preimage = invoices.get(paymentHash)
      return preimage ? { paid: true, preimage } : { paid: false }
    },
    async sendPayment() {
      return { preimage: randomBytes(32).toString('hex') }
    },
  }
  const storage = memoryStorage()
  const rail = createIETFSessionRail({
    hmacSecret: HMAC_SECRET,
    realm: REALM,
    backend,
    storage,
    session: { maxSessionDurationMs: 60_000, maxDepositSats: 10_000 },
  })
  const engine = createTollBooth({
    rootKey: ROOT_KEY,
    storage,
    upstream: upstreamUrl,
    pricing: { '/api/paid': 100 },
    // The charge rail also accepts `Authorization: Payment`; it must leave
    // session credentials alone whatever the rail order.
    rails: chargeRailFirst
      ? [createIETFPaymentRail({ hmacSecret: HMAC_SECRET, realm: REALM, backend, storage }), rail]
      : [rail],
  })

  async function openCredential(): Promise<string> {
    const fragment = await rail.challenge('/api/paid', { sats: 500 })
    const www = fragment.headers['WWW-Authenticate']
    const param = (name: string) => www.match(new RegExp(`${name}="([^"]+)"`))![1]
    const request = param('request')
    const { deposit } = JSON.parse(Buffer.from(request, 'base64url').toString())
    const credential = {
      challenge: {
        id: param('id'),
        realm: param('realm'),
        method: param('method'),
        intent: param('intent'),
        request,
        expires: param('expires'),
      },
      payload: { action: 'open', preimage: invoices.get(deposit.paymentHash), returnInvoice: AMOUNTLESS_INVOICE },
    }
    return `Payment ${Buffer.from(JSON.stringify(credential)).toString('base64url')}`
  }

  return { engine, openCredential }
}

function bearerCredential(token: string): string {
  return `Payment ${Buffer.from(JSON.stringify({ payload: { action: 'bearer', sessionToken: token } })).toString('base64url')}`
}

type Send = (path: string, init: RequestInit) => Promise<Response>

async function expectSessionHeaders(send: Send, openCredential: () => Promise<string>) {
  upstreamSeen.length = 0
  const opened = await send('/api/paid', { headers: { authorization: await openCredential() } })
  expect(opened.status).toBe(200)
  const token = opened.headers.get('x-session-token')
  expect(token).toMatch(/^[0-9a-f]{64}$/)
  expect(opened.headers.get('x-session-id')).toBeTruthy()
  expect(opened.headers.get('x-session-expires')).toBeTruthy()
  expect(opened.headers.get('x-session-balance')).toBe('400')
  expect(opened.headers.get('cache-control')).toBe('private, no-store')

  // The token opens the session for later requests.
  const bearer = await send('/api/paid', { headers: { authorization: bearerCredential(token!) } })
  expect(bearer.status).toBe(200)
  expect(bearer.headers.get('x-session-balance')).toBe('300')

  // The session secret stays between the client and toll-booth.
  expect(upstreamSeen.length).toBeGreaterThan(0)
  for (const headers of upstreamSeen) {
    expect(headers['x-session-token']).toBeUndefined()
    expect(headers['x-session-id']).toBeUndefined()
  }
}

describe('client response headers reach the client in every adapter', () => {
  it('Express', async () => {
    const { engine, openCredential } = sessionEngine()
    const app = express()
    app.use(createExpressMiddleware({ engine, upstream: upstreamUrl }))
    const server = createServer(app)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      await expectSessionHeaders((path, init) => fetch(base + path, init), openCredential)
    } finally {
      server.close()
    }
  })

  it('Web Standard', async () => {
    const { engine, openCredential } = sessionEngine()
    const handler = createWebStandardMiddleware({ engine, upstream: upstreamUrl })
    await expectSessionHeaders((path, init) => handler(new Request(`http://booth.test${path}`, init)), openCredential)
  })

  it('Web Standard, with the charge rail registered before the session rail', async () => {
    const { engine, openCredential } = sessionEngine(true)
    const handler = createWebStandardMiddleware({ engine, upstream: upstreamUrl })
    await expectSessionHeaders((path, init) => handler(new Request(`http://booth.test${path}`, init)), openCredential)
  })

  it('Hono', async () => {
    const { engine, openCredential } = sessionEngine()
    const booth = createHonoTollBooth({ engine })
    const app = new Hono<TollBoothEnv>()
    app.use('/api/*', booth.authMiddleware)
    app.get('/api/paid', async (c) => {
      // A downstream handler that proxies with the request headers it was given.
      const res = await fetch(upstreamUrl + '/api/paid', { headers: c.req.raw.headers })
      return new Response(res.body, res)
    })
    await expectSessionHeaders((path, init) => app.request(path, init), openCredential)
  })

  it('Hono returns balance headers on a credit-mode proxy', async () => {
    const engine: TollBoothEngine = {
      freeTier: null,
      upstream: upstreamUrl,
      reconcile: () => ({ adjusted: false, newBalance: 0, delta: 0 }),
      async handle() {
        return {
          action: 'proxy',
          upstream: upstreamUrl,
          headers: { 'X-Credit-Balance': '42', 'X-Toll-Caveat-Model': 'x', 'Payment-Receipt': 'r' },
          paymentHash: 'a'.repeat(64),
          creditBalance: 42,
        }
      },
    }
    const booth = createHonoTollBooth({ engine })
    const app = new Hono<TollBoothEnv>()
    app.use('/api/*', booth.authMiddleware)
    app.get('/api/paid', (c) => c.json({ caveat: c.req.header('x-toll-caveat-model') }))
    const res = await app.request('/api/paid')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ caveat: 'x' })
    expect(res.headers.get('x-credit-balance')).toBe('42')
    expect(res.headers.get('payment-receipt')).toBe('r')
    expect(res.headers.get('x-toll-caveat-model')).toBeNull()
  })
})

describe('engine response headers from rails', () => {
  it('refuses reserved and malformed header names from a rail', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      rootKey: ROOT_KEY,
      storage,
      upstream: upstreamUrl,
      pricing: { '/api/paid': 10 },
      rails: [{
        type: 'test',
        creditSupported: false,
        async challenge() { return { headers: {}, body: {} } },
        detect: () => true,
        verify: () => ({
          authenticated: true,
          paymentId: randomBytes(16).toString('hex'),
          mode: 'per-request',
          currency: 'sat',
          responseHeaders: {
            'X-Session-Token': 'tok\r\nSet-Cookie: x=1',
            'X-Credit-Balance': '999999',
            'X-Toll-Caveat-Admin': 'true',
            'Bad Header': 'x',
          },
        }),
      }],
    })
    const result = await engine.handle({ method: 'GET', path: '/api/paid', headers: {}, ip: '127.0.0.1' })
    expect(result.action).toBe('proxy')
    if (result.action !== 'proxy') return
    expect(result.headers['X-Session-Token']).toBe('tokSet-Cookie: x=1')
    expect(result.headers['X-Credit-Balance']).toBeUndefined()
    expect(result.headers['X-Toll-Caveat-Admin']).toBeUndefined()
    expect(result.headers['Bad Header']).toBeUndefined()
  })
})
