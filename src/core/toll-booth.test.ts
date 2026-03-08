// src/core/toll-booth.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createTollBooth } from './toll-booth.js'
import { mintMacaroon } from '../macaroon.js'
import { memoryStorage } from '../storage/memory.js'
import type { LightningBackend } from '../types.js'
import type { TollBoothRequest, TollBoothCoreConfig } from './types.js'

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

function makePreimageAndHash(): { preimage: string; paymentHash: string } {
  const preimage = randomBytes(32).toString('hex')
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
  return { preimage, paymentHash }
}

function makeRequest(overrides: Partial<TollBoothRequest> = {}): TollBoothRequest {
  return {
    method: 'POST',
    path: '/route',
    headers: {},
    ip: '127.0.0.1',
    ...overrides,
  }
}

function makeConfig(overrides: Partial<TollBoothCoreConfig> = {}): TollBoothCoreConfig {
  return {
    backend: mockBackend(),
    storage: memoryStorage(),
    pricing: { '/route': 10, '/isochrone': 5 },
    upstream: 'http://localhost:8002',
    rootKey: ROOT_KEY,
    ...overrides,
  }
}

describe('TollBoothEngine (core)', () => {
  it('passes unpriced routes through', async () => {
    const engine = createTollBooth(makeConfig())
    const result = await engine.handle(makeRequest({ path: '/health' }))
    expect(result.action).toBe('pass')
    expect(result).toHaveProperty('upstream', 'http://localhost:8002')
  })

  it('issues 402 challenge for priced route without auth', async () => {
    const engine = createTollBooth(makeConfig())
    const result = await engine.handle(makeRequest())
    expect(result.action).toBe('challenge')
    if (result.action === 'challenge') {
      expect(result.status).toBe(402)
      expect(result.headers['WWW-Authenticate']).toMatch(/^L402 /)
      expect(result.body).toHaveProperty('invoice')
      expect(result.body).toHaveProperty('macaroon')
      expect(result.body).toHaveProperty('payment_hash')
    }
  })

  it('allows free tier requests', async () => {
    const engine = createTollBooth(makeConfig({ freeTier: { requestsPerDay: 5 } }))
    const result = await engine.handle(makeRequest())
    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') {
      expect(result.freeRemaining).toBe(4)
    }
  })

  it('challenges after free tier exhausted', async () => {
    const config = makeConfig({ freeTier: { requestsPerDay: 2 } })
    const engine = createTollBooth(config)

    // Exhaust free tier
    await engine.handle(makeRequest({ ip: '1.2.3.4' }))
    await engine.handle(makeRequest({ ip: '1.2.3.4' }))

    const result = await engine.handle(makeRequest({ ip: '1.2.3.4' }))
    expect(result.action).toBe('challenge')
  })

  it('authorises valid L402 token and debits credit', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const config = makeConfig({ storage })
    const engine = createTollBooth(config)

    // Mint macaroon with 1000 sats credit
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const req = makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
    })

    const result = await engine.handle(req)
    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') {
      expect(result.creditBalance).toBe(990) // 1000 - 10 cost
    }
  })

  it('rejects invalid preimage (falls through to challenge)', async () => {
    const { paymentHash } = makePreimageAndHash()
    const wrongPreimage = 'ff'.repeat(32)

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const engine = createTollBooth(makeConfig())

    const result = await engine.handle(makeRequest({
      headers: { authorization: `L402 ${macaroon}:${wrongPreimage}` },
    }))
    expect(result.action).toBe('challenge')
  })

  it('credits on first valid preimage presentation (onPayment fired once)', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const onPayment = vi.fn()
    const config = makeConfig({ storage, onPayment })
    const engine = createTollBooth(config)

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const req = makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
    })

    // First request — credits and fires onPayment
    await engine.handle(req)
    expect(onPayment).toHaveBeenCalledTimes(1)
    expect(onPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentHash, amountSats: 1000 }),
    )

    // Second request — no new credit, no second onPayment
    await engine.handle(req)
    expect(onPayment).toHaveBeenCalledTimes(1)
  })

  it('fires onRequest callback (authenticated: false for free tier)', async () => {
    const onRequest = vi.fn()
    const engine = createTollBooth(makeConfig({
      freeTier: { requestsPerDay: 5 },
      onRequest,
    }))

    await engine.handle(makeRequest())
    expect(onRequest).toHaveBeenCalledTimes(1)
    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/route',
        authenticated: false,
        satsDeducted: 0,
      }),
    )
  })

  it('fires onChallenge callback', async () => {
    const onChallenge = vi.fn()
    const engine = createTollBooth(makeConfig({ onChallenge }))

    await engine.handle(makeRequest())
    expect(onChallenge).toHaveBeenCalledTimes(1)
    expect(onChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/route',
        amountSats: 1000,
      }),
    )
  })
})
