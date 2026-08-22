// End-to-end wiring for the lnurlcash rail: a priced route challenges with
// an X-LNURLcash payment request, a real bearer note from a real (mock) mint
// buys access, and the same note buys nothing a second time.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createMockMint } from 'lnurlcash-conformance/mock-mint'
import type { MockMint } from 'lnurlcash-conformance/mock-mint'
import { randomBytes } from 'node:crypto'
import { createTollBooth } from './toll-booth.js'
import { createLnurlcashRail, LNURLCASH_REQUEST_PREFIX } from './lnurlcash-rail.js'
import { memoryStorage } from '../storage/memory.js'
import type { TollBoothRequest, TollBoothCoreConfig } from './types.js'

const ROOT_KEY = 'a'.repeat(64)

function makeRequest(overrides: Partial<TollBoothRequest> = {}): TollBoothRequest {
  return { method: 'GET', path: '/route', headers: {}, ip: '127.0.0.1', ...overrides }
}

function fundedNote(mint: MockMint, amountMsat: number): string {
  const k1 = randomBytes(32).toString('hex')
  mint.state.creditNote(k1, amountMsat)
  return `${mint.url}/w?k1=${k1}&amount=${amountMsat}`
}

describe('lnurlcash rail wiring', () => {
  let mint: MockMint

  beforeAll(async () => {
    mint = await createMockMint()
  })

  afterAll(async () => {
    await mint.close()
  })

  function makeEngine(overrides: Partial<TollBoothCoreConfig> = {}) {
    const storage = memoryStorage()
    const config: TollBoothCoreConfig = {
      storage,
      pricing: { '/route': 10 },
      upstream: 'http://localhost:8002',
      rootKey: ROOT_KEY,
      rails: [createLnurlcashRail({ mints: [`127.0.0.1:${mint.port}`] }, storage)],
      ...overrides,
    }
    return { engine: createTollBooth(config), storage }
  }

  it('challenges an unpaid request with an X-LNURLcash payment request', async () => {
    const { engine } = makeEngine()
    const result = await engine.handle(makeRequest())

    expect(result.action).toBe('challenge')
    if (result.action !== 'challenge') return
    expect(result.status).toBe(402)
    expect(result.headers['X-LNURLcash'].startsWith(LNURLCASH_REQUEST_PREFIX)).toBe(true)
    // The body is the charge request the published schema for this method
    // validates: amount as a decimal string, and nothing beyond these three.
    expect(result.body.lnurlcash).toEqual({
      amount: '10',
      currency: 'sat',
      methodDetails: { mints: [`127.0.0.1:${mint.port}`] },
    })
  })

  it('names the header in auth_hint when the booth is named', async () => {
    const { engine } = makeEngine({ serviceName: 'Note Paywall' })
    const result = await engine.handle(makeRequest())

    expect(result.action).toBe('challenge')
    if (result.action !== 'challenge') return
    expect(result.body.auth_hint).toBe('Present a LUD-25 bearer note URL in X-LNURLcash')
  })

  it('lets a note through once, and never again', async () => {
    const { engine } = makeEngine()
    const note = fundedNote(mint, 21_000)

    const paid = await engine.handle(makeRequest({ headers: { 'x-lnurlcash': note } }))
    expect(paid.action).toBe('proxy')
    if (paid.action === 'proxy') expect(paid.creditBalance).toBe(11)

    const replay = await engine.handle(makeRequest({ headers: { 'x-lnurlcash': note } }))
    expect(replay.action).toBe('challenge')
    expect(replay.status).toBe(402)
  })

  it('credits the whole note and reports what is left over', async () => {
    const { engine, storage } = makeEngine()
    const note = fundedNote(mint, 21_000)

    const first = await engine.handle(makeRequest({ headers: { 'x-lnurlcash': note } }))
    expect(first.action).toBe('proxy')
    if (first.action !== 'proxy') return

    // A 21 sat note bought a 10 sat request. The surplus is held as credit
    // against the settlement, and the response says so.
    expect(first.headers['X-Credit-Balance']).toBe('11')
    expect(storage.balance(first.paymentHash!, 'sat')).toBe(11)
  })

  it('challenges a note that cannot cover the route price', async () => {
    const { engine } = makeEngine()
    const note = fundedNote(mint, 5_000)

    const result = await engine.handle(makeRequest({ headers: { 'x-lnurlcash': note } }))
    expect(result.action).toBe('challenge')
    expect(result.status).toBe(402)
  })
})
