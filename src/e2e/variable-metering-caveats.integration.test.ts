// src/e2e/variable-metering-caveats.integration.test.ts
//
// End-to-end tests for variable metering (reconcile) and caveat-scoped macaroons.
// Uses in-memory storage and a mock backend — no external services required.
// These tests always run as part of the standard test suite.
//
import { describe, it, expect, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createTollBooth } from '../core/toll-booth.js'
import { memoryStorage } from '../storage/memory.js'
import { mintMacaroon } from '../macaroon.js'
import type { LightningBackend } from '../types.js'

const ROOT_KEY = randomBytes(32).toString('hex')

/** Creates a fresh preimage/paymentHash pair. */
function makeCredential(): { preimage: string; paymentHash: string } {
  const preimage = randomBytes(32).toString('hex')
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
  return { preimage, paymentHash }
}

/** Builds a mock LightningBackend that never actually sends invoices. */
function mockBackend(): LightningBackend {
  return {
    createInvoice: vi.fn().mockResolvedValue({ bolt11: 'lnbc1mock', paymentHash: randomBytes(32).toString('hex') }),
    checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
  }
}

describe('variable metering and caveat-scoped macaroons', () => {
  it('full flow: create invoice with caveats, pay, request with X-Toll-Cost reconciliation', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend: mockBackend(),
      storage,
      pricing: { '/api/chat': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    // Step 1: Request the priced endpoint without auth — expect a 402 challenge
    const challengeResult = await engine.handle({
      method: 'GET',
      path: '/api/chat',
      headers: {},
      ip: '127.0.0.1',
    })

    expect(challengeResult.action).toBe('challenge')

    // Step 2: Simulate payment out-of-band with a fresh credential
    const { preimage, paymentHash } = makeCredential()
    storage.settleWithCredit(paymentHash, 1000, preimage)

    // Step 3: Mint a macaroon carrying custom caveats
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, [
      'route = /api/*',
      'model = llama3',
    ])

    // Step 4: Request with L402 auth on a matching path
    const authHeader = `L402 ${macaroon}:${preimage}`
    const proxyResult = await engine.handle({
      method: 'POST',
      path: '/api/chat',
      headers: { authorization: authHeader },
      ip: '127.0.0.1',
    })

    expect(proxyResult.action).toBe('proxy')
    if (proxyResult.action !== 'proxy') return // narrow type

    // Cost was estimated at 10 sats (the configured price for /api/chat)
    expect(proxyResult.paymentHash).toBe(paymentHash)
    expect(proxyResult.estimatedCost).toBe(10)

    // Custom caveat should be forwarded as a header to the upstream
    expect(proxyResult.headers['X-Toll-Caveat-Model']).toBe('llama3')

    // Remaining balance after deducting estimated cost: 1000 - 10 = 990
    expect(proxyResult.creditBalance).toBe(990)

    // Step 5: Reconcile — actual cost was only 3, so 7 sats are refunded
    const reconciled = engine.reconcile(paymentHash, 3)

    expect(reconciled.adjusted).toBe(true)
    expect(reconciled.delta).toBe(7)
    // 1000 - 10 + 7 = 997
    expect(reconciled.newBalance).toBe(997)
  })

  it('rejects request when route caveat does not match', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend: mockBackend(),
      storage,
      pricing: { '/api/chat': 10, '/other/path': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    const { preimage, paymentHash } = makeCredential()
    storage.settleWithCredit(paymentHash, 1000, preimage)

    // Macaroon is scoped to /api/* only
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, ['route = /api/*'])
    const authHeader = `L402 ${macaroon}:${preimage}`

    // Request a path outside the allowed route pattern
    const result = await engine.handle({
      method: 'GET',
      path: '/other/path',
      headers: { authorization: authHeader },
      ip: '127.0.0.1',
    })

    // Macaroon is cryptographically valid but fails the route caveat — expect a fresh challenge
    expect(result.action).toBe('challenge')
  })

  it('rejects request when macaroon is expired', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend: mockBackend(),
      storage,
      pricing: { '/api/chat': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    const { preimage, paymentHash } = makeCredential()
    storage.settleWithCredit(paymentHash, 1000, preimage)

    // Expiry timestamp is well in the past
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, [
      'expires = 2020-01-01T00:00:00Z',
    ])
    const authHeader = `L402 ${macaroon}:${preimage}`

    const result = await engine.handle({
      method: 'GET',
      path: '/api/chat',
      headers: { authorization: authHeader },
      ip: '127.0.0.1',
    })

    // Macaroon has expired — expect a fresh payment challenge
    expect(result.action).toBe('challenge')
  })
})
