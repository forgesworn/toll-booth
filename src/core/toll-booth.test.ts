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
      const l402 = result.body.l402 as Record<string, unknown>
      expect(l402).toHaveProperty('invoice')
      expect(l402).toHaveProperty('macaroon')
      expect(l402).toHaveProperty('payment_hash')
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

  it('does not re-credit after balance is drained to zero (replay protection)', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const onPayment = vi.fn()
    const config = makeConfig({
      storage,
      onPayment,
      pricing: { '/route': 1000 }, // cost equals full credit
    })
    const engine = createTollBooth(config)

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const req = makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
    })

    // First request: settles, credits 1000, debits 1000 → balance 0
    const r1 = await engine.handle(req)
    expect(r1.action).toBe('proxy')
    if (r1.action === 'proxy') expect(r1.creditBalance).toBe(0)
    expect(onPayment).toHaveBeenCalledTimes(1)

    // Replay after drain: should NOT re-credit — must reject (insufficient balance)
    const r2 = await engine.handle(req)
    expect(r2.action).toBe('challenge') // falls through: 0 balance, no re-credit
    expect(onPayment).toHaveBeenCalledTimes(1) // still only once
  })

  it('accepts settled macaroon only with settlement secret (Cashu path)', async () => {
    const { paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const config = makeConfig({ storage })
    const engine = createTollBooth(config)

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const settlementSecret = 'cashu-settlement-secret'

    // Simulate Cashu settlement: settle + credit with settlement secret.
    storage.settleWithCredit(paymentHash, 1000, settlementSecret)

    // Placeholder suffix should be rejected.
    const req = makeRequest({
      headers: { authorization: `L402 ${macaroon}:settled` },
    })
    const rejected = await engine.handle(req)
    expect(rejected.action).toBe('challenge')

    // Settlement secret suffix should authorise.
    const okReq = makeRequest({
      headers: { authorization: `L402 ${macaroon}:${settlementSecret}` },
    })

    const result = await engine.handle(okReq)
    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') expect(result.creditBalance).toBe(990)
  })

  it('rejects attacker who records macaroon from 402 and waits for settlement', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage }))

    // Attacker observes the macaroon from the 402 challenge
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)

    // Legitimate user settles via Lightning (stores preimage as secret)
    storage.settleWithCredit(paymentHash, 1000, preimage)

    // Attacker tries various guesses — all should fail
    for (const fakeProof of ['settled', 'x'.repeat(64), '', 'garbage']) {
      const req = makeRequest({
        headers: { authorization: `L402 ${macaroon}:${fakeProof}` },
      })
      const result = await engine.handle(req)
      expect(result.action).toBe('challenge')
    }

    // Only the real preimage works
    const req = makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
    })
    const result = await engine.handle(req)
    expect(result.action).toBe('proxy')
  })

  it('proxy result includes paymentHash and estimatedCost', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const result = await engine.handle(makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
    }))

    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') {
      expect(result.paymentHash).toBe(paymentHash)
      expect(result.estimatedCost).toBe(10)
    }
  })
})

describe('reconcile', () => {
  it('refunds when actual cost is less than estimated', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage, pricing: { '/route': 100 } }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const req = makeRequest({ headers: { authorization: `L402 ${macaroon}:${preimage}` } })

    await engine.handle(req)

    const result = engine.reconcile(paymentHash, 30)
    expect(result.adjusted).toBe(true)
    expect(result.delta).toBe(70)
    expect(result.newBalance).toBe(970)
  })

  it('charges more when actual cost exceeds estimate', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage, pricing: { '/route': 10 } }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const req = makeRequest({ headers: { authorization: `L402 ${macaroon}:${preimage}` } })

    await engine.handle(req)

    const result = engine.reconcile(paymentHash, 50)
    expect(result.adjusted).toBe(true)
    expect(result.delta).toBe(-40)
    expect(result.newBalance).toBe(950)
  })

  it('clamps to zero on over-charge', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage, pricing: { '/route': 10 } }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 50)
    const req = makeRequest({ headers: { authorization: `L402 ${macaroon}:${preimage}` } })

    await engine.handle(req)

    const result = engine.reconcile(paymentHash, 100)
    expect(result.adjusted).toBe(true)
    expect(result.newBalance).toBe(0)
  })

  it('no-ops when actual equals estimated', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage, pricing: { '/route': 10 } }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const req = makeRequest({ headers: { authorization: `L402 ${macaroon}:${preimage}` } })

    await engine.handle(req)

    const result = engine.reconcile(paymentHash, 10)
    expect(result.adjusted).toBe(false)
    expect(result.delta).toBe(0)
    expect(result.newBalance).toBe(990)
  })
})

describe('strictPricing', () => {
  it('challenges unpriced routes when strictPricing is true', async () => {
    const engine = createTollBooth(makeConfig({ strictPricing: true }))
    const result = await engine.handle(makeRequest({ path: '/unpriced-route' }))
    expect(result.action).toBe('challenge')
  })

  it('passes unpriced routes when strictPricing is false (default)', async () => {
    const engine = createTollBooth(makeConfig())
    const result = await engine.handle(makeRequest({ path: '/unpriced-route' }))
    expect(result.action).toBe('pass')
  })

  it('uses defaultInvoiceAmount as cost for unpriced routes under strictPricing', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({
      storage,
      strictPricing: true,
      defaultInvoiceAmount: 50,
    }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const req = makeRequest({
      path: '/unpriced-route',
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
    })

    const result = await engine.handle(req)
    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') {
      // 1000 credit - 50 cost (defaultInvoiceAmount) = 950
      expect(result.creditBalance).toBe(950)
    }
  })
})

describe('caveat verification and forwarding', () => {
  it('rejects expired macaroon', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage }))

    const past = new Date(Date.now() - 1000).toISOString()
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, [`expires = ${past}`])
    const result = await engine.handle(makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
    }))
    expect(result.action).toBe('challenge')
  })

  it('rejects route-restricted macaroon on wrong path', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, ['route = /other'])
    const result = await engine.handle(makeRequest({
      path: '/route',
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
    }))
    expect(result.action).toBe('challenge')
  })

  it('forwards custom caveats as X-Toll-Caveat-* headers', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, ['model = llama3', 'plan = premium'])
    const result = await engine.handle(makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
    }))

    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') {
      expect(result.headers['X-Toll-Caveat-Model']).toBe('llama3')
      expect(result.headers['X-Toll-Caveat-Plan']).toBe('premium')
    }
  })
})

describe('Cashu-only mode (no Lightning backend)', () => {
  function makeCashuConfig(overrides: Partial<TollBoothCoreConfig> = {}): TollBoothCoreConfig {
    return {
      backend: undefined,
      storage: memoryStorage(),
      pricing: { '/route': 10 },
      upstream: 'http://localhost:8002',
      rootKey: ROOT_KEY,
      ...overrides,
    }
  }

  it('issues 402 challenge with synthetic payment hash and no bolt11', async () => {
    const engine = createTollBooth(makeCashuConfig())
    const result = await engine.handle(makeRequest())

    expect(result.action).toBe('challenge')
    if (result.action === 'challenge') {
      expect(result.status).toBe(402)
      expect(result.headers['WWW-Authenticate']).toMatch(/^L402 macaroon="/)
      // Body has l402.payment_hash but empty invoice
      const l402 = result.body.l402 as Record<string, unknown>
      expect(l402.payment_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(l402.invoice).toBe('')
      expect(l402).toHaveProperty('macaroon')
    }
  })

  it('authorises access after Cashu settlement', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth(makeCashuConfig({ storage }))

    // Get a challenge to obtain a payment hash and macaroon
    const challenge = await engine.handle(makeRequest())
    expect(challenge.action).toBe('challenge')
    if (challenge.action !== 'challenge') return

    const l402 = challenge.body.l402 as Record<string, unknown>
    const paymentHash = l402.payment_hash as string
    const macaroon = l402.macaroon as string

    // Simulate Cashu redemption: settle + credit with a secret suffix.
    const settlementSecret = 'cashu-settlement-secret'
    storage.settleWithCredit(paymentHash, 1000, settlementSecret)

    // Use macaroon with settlement secret suffix.
    const req = makeRequest({
      headers: { authorization: `L402 ${macaroon}:${settlementSecret}` },
    })

    const result = await engine.handle(req)
    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') expect(result.creditBalance).toBe(990)
  })

  it('generates unique payment hashes per challenge', async () => {
    const engine = createTollBooth(makeCashuConfig())

    const r1 = await engine.handle(makeRequest())
    const r2 = await engine.handle(makeRequest())

    if (r1.action === 'challenge' && r2.action === 'challenge') {
      const l402_1 = r1.body.l402 as Record<string, unknown>
      const l402_2 = r2.body.l402 as Record<string, unknown>
      expect(l402_1.payment_hash).not.toBe(l402_2.payment_hash)
    }
  })
})

describe('tiered pricing', () => {
  const tieredPricing = {
    '/route': {
      default: 5,
      standard: 21,
      premium: 42,
    },
  }

  it('resolves default tier when no tier specified', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage, pricing: tieredPricing }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const result = await engine.handle(makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
    }))

    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') {
      // default tier = 5 sats, not 42 (premium)
      expect(result.creditBalance).toBe(995)
    }
  })

  it('resolves tier from req.tier field', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage, pricing: tieredPricing }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const result = await engine.handle(makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
      tier: 'premium',
    }))

    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') {
      // premium tier = 42 sats
      expect(result.creditBalance).toBe(958)
    }
  })

  it('returns challenge for unknown tier', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage, pricing: tieredPricing }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const result = await engine.handle(makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
      tier: 'nonexistent',
    }))

    expect(result.action).toBe('challenge')
  })

  it('rejects tier names with invalid characters', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage, pricing: tieredPricing }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)

    for (const badTier of ['UPPERCASE', 'has spaces', 'special!chars', '../traversal', 'a'.repeat(33)]) {
      const result = await engine.handle(makeRequest({
        headers: { authorization: `L402 ${macaroon}:${preimage}` },
        tier: badTier,
      }))
      expect(result.action).toBe('challenge')
    }
  })

  it('flat pricing still works unchanged (tier is undefined)', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({
      storage,
      pricing: { '/route': 10 },
    }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const result = await engine.handle(makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
    }))

    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') {
      expect(result.creditBalance).toBe(990)
      expect(result.tier).toBeUndefined()
    }
  })

  it('dual-currency tiered pricing resolves correctly', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({
      storage,
      pricing: {
        '/route': {
          default: { sats: 5, usd: 1 },
          premium: { sats: 42, usd: 8 },
        },
      },
    }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const result = await engine.handle(makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
      tier: 'premium',
    }))

    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') {
      // premium sats cost = 42
      expect(result.creditBalance).toBe(958)
      expect(result.tier).toBe('premium')
    }
  })

  it('tier included in RequestEvent callback', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const onRequest = vi.fn()
    const engine = createTollBooth(makeConfig({
      storage,
      pricing: tieredPricing,
      onRequest,
    }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    await engine.handle(makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
      tier: 'standard',
    }))

    expect(onRequest).toHaveBeenCalledTimes(1)
    expect(onRequest).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'standard' }),
    )
  })

  it('X-Toll-Tier header in proxy result headers', async () => {
    const { preimage, paymentHash } = makePreimageAndHash()
    const storage = memoryStorage()
    const engine = createTollBooth(makeConfig({ storage, pricing: tieredPricing }))

    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
    const result = await engine.handle(makeRequest({
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
      tier: 'premium',
    }))

    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') {
      expect(result.headers['X-Toll-Tier']).toBe('premium')
    }
  })
})

describe('config validation and challenge tiers map', () => {
  it('throws if tiered route has no default key', () => {
    expect(() => createTollBooth(makeConfig({
      pricing: { '/route': { standard: 21, premium: 42 } as any },
    }))).toThrow(/default/)
  })

  it('challenge includes tiers map for tiered routes', async () => {
    const engine = createTollBooth(makeConfig({
      pricing: {
        '/route': { default: 5, standard: 21, premium: 42 },
      },
    }))

    const result = await engine.handle(makeRequest())
    expect(result.action).toBe('challenge')
    if (result.action === 'challenge') {
      expect(result.body.tiers).toEqual({
        default: { sats: 5 },
        standard: { sats: 21 },
        premium: { sats: 42 },
      })
    }
  })

  it('challenge omits tiers map for flat-priced routes', async () => {
    const engine = createTollBooth(makeConfig({
      pricing: { '/route': 10 },
    }))

    const result = await engine.handle(makeRequest())
    expect(result.action).toBe('challenge')
    if (result.action === 'challenge') {
      expect(result.body.tiers).toBeUndefined()
    }
  })
})
