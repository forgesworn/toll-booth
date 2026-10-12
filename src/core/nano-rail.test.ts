import { describe, it, expect, vi } from 'vitest'
import { createNanoRail, decodeNanoAddress, isValidNanoAddress, requiredRaw } from './nano-rail.js'
import type { NanoRailConfig } from './nano-rail.js'

const GENESIS = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3'
const BURN = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp'
const HASH = 'A'.repeat(64)
// 10^24 raw per cent (1 XNO = 10^30 raw, i.e. 1 XNO = $10,000 for round numbers)
const RATE = 10n ** 24n

function sendBlock(overrides: Record<string, unknown> = {}, contents: Record<string, unknown> = {}) {
  return {
    block_account: BURN,
    amount: (5n * RATE).toString(),
    balance: '1',
    height: '2',
    local_timestamp: String(Math.floor(Date.now() / 1000) - 5),
    confirmed: 'true',
    subtype: 'send',
    contents: { type: 'state', account: BURN, link_as_account: GENESIS, ...contents },
    ...overrides,
  }
}

function mockFetch(block: unknown, opts: { status?: number; hash?: string } = {}) {
  return vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { hashes: string[] }
    const key = opts.hash ?? body.hashes[0]
    const payload = block === undefined ? { error: 'Block not found' } : { blocks: { [key]: block } }
    return new Response(JSON.stringify(payload), { status: opts.status ?? 200 })
  }) as unknown as typeof fetch
}

function rail(overrides: Partial<NanoRailConfig> = {}) {
  return createNanoRail({ address: GENESIS, rawPerCent: RATE, fetch: mockFetch(sendBlock()), ...overrides })
}

function req(headers: Record<string, string | undefined> = {}) {
  return { method: 'GET', path: '/api/test', headers, ip: '127.0.0.1' }
}

describe('Nano address validation', () => {
  it('accepts the genesis account', () => {
    expect(isValidNanoAddress(GENESIS)).toBe(true)
    expect(isValidNanoAddress(BURN)).toBe(true)
  })

  it('accepts the legacy xrb_ prefix with the same key', () => {
    const xrb = 'xrb_' + GENESIS.slice(5)
    expect(Buffer.from(decodeNanoAddress(xrb)!).toString('hex'))
      .toBe(Buffer.from(decodeNanoAddress(GENESIS)!).toString('hex'))
  })

  it('decodes the genesis public key', () => {
    expect(Buffer.from(decodeNanoAddress(GENESIS)!).toString('hex').toUpperCase())
      .toBe('E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA')
  })

  it('rejects a one-character change (checksum)', () => {
    const tampered = GENESIS.slice(0, 20) + (GENESIS[20] === 'a' ? 'b' : 'a') + GENESIS.slice(21)
    expect(isValidNanoAddress(tampered)).toBe(false)
    const badChecksum = GENESIS.slice(0, -1) + (GENESIS.endsWith('3') ? '4' : '3')
    expect(isValidNanoAddress(badChecksum)).toBe(false)
  })

  it('rejects wrong prefix, length, and alphabet', () => {
    expect(isValidNanoAddress('ban_' + GENESIS.slice(5))).toBe(false)
    expect(isValidNanoAddress(GENESIS.slice(0, -1))).toBe(false)
    expect(isValidNanoAddress(GENESIS.slice(0, 10) + '0' + GENESIS.slice(11))).toBe(false)
    expect(isValidNanoAddress(GENESIS.toUpperCase())).toBe(false)
  })
})

describe('requiredRaw', () => {
  it('multiplies whole cents exactly', () => {
    expect(requiredRaw(5, RATE)).toBe(5n * RATE)
  })

  it('rounds fractional cents up', () => {
    expect(requiredRaw(0.5, 3n)).toBe(2n)
  })
})

describe('NanoRail', () => {
  describe('construction', () => {
    it('rejects an invalid address', () => {
      expect(() => rail({ address: GENESIS.slice(0, -1) + 'x' })).toThrow(/valid Nano address/)
    })

    it('requires exactly one rate source', () => {
      expect(() => createNanoRail({ address: GENESIS })).toThrow(/rawPerCent/)
      expect(() => createNanoRail({ address: GENESIS, rawPerCent: RATE, quoteRawPerCent: async () => RATE })).toThrow(/rawPerCent/)
    })

    it('rejects a non-positive or non-integer rate', () => {
      expect(() => rail({ rawPerCent: 0n })).toThrow(/positive integer/)
      expect(() => rail({ rawPerCent: '1.5' })).toThrow(/positive integer/)
    })
  })

  describe('canChallenge', () => {
    it('requires a positive USD price', () => {
      expect(rail().canChallenge!({ usd: 5 })).toBe(true)
      expect(rail().canChallenge!({ sats: 10 })).toBe(false)
      expect(rail().canChallenge!({ usd: 0 })).toBe(false)
    })
  })

  describe('challenge', () => {
    it('advertises address, raw amount and payment URI', async () => {
      const fragment = await rail().challenge('/api/test', { usd: 5 })
      const uri = `nano:${GENESIS}?amount=${5n * RATE}`
      expect(fragment.headers['X-Nano']).toBe(uri)
      expect(fragment.body.nano).toEqual({ address: GENESIS, amount_raw: (5n * RATE).toString(), amount_usd: 5, uri })
    })

    it('uses the operator quote function', async () => {
      const quote = vi.fn().mockResolvedValue('7')
      const fragment = await rail({ rawPerCent: undefined, quoteRawPerCent: quote }).challenge('/x', { usd: 3 })
      expect((fragment.body.nano as { amount_raw: string }).amount_raw).toBe('21')
      expect(quote).toHaveBeenCalled()
    })

    it('omits Nano when the quote fails', async () => {
      const fragment = await rail({ rawPerCent: undefined, quoteRawPerCent: async () => { throw new Error('down') } })
        .challenge('/x', { usd: 3 })
      expect(fragment).toEqual({ headers: {}, body: {} })
    })
  })

  describe('detect', () => {
    it('detects the X-Nano-Block header', () => {
      expect(rail().detect(req({ 'x-nano-block': HASH }))).toBe(true)
      expect(rail().detect(req())).toBe(false)
    })
  })

  describe('verify', () => {
    it('accepts a confirmed send to the address covering the price', async () => {
      const fetchFn = mockFetch(sendBlock())
      const result = await rail({ fetch: fetchFn }).verify(req({ 'x-nano-block': HASH.toLowerCase() }), { usd: 5 })
      expect(result).toEqual({ authenticated: true, paymentId: `nano:${HASH}`, mode: 'per-request', currency: 'usd' })
      const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(url).toBe('https://rpc.nano.to')
      expect(JSON.parse(init.body)).toEqual({ action: 'blocks_info', json_block: 'true', hashes: [HASH] })
    })

    it('accepts an overpayment', async () => {
      const result = await rail({ fetch: mockFetch(sendBlock({ amount: (6n * RATE).toString() })) })
        .verify(req({ 'x-nano-block': HASH }), { usd: 5 })
      expect(result.authenticated).toBe(true)
    })

    it('rejects an underpayment by one raw', async () => {
      const result = await rail({ fetch: mockFetch(sendBlock({ amount: (5n * RATE - 1n).toString() })) })
        .verify(req({ 'x-nano-block': HASH }), { usd: 5 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects an unconfirmed block', async () => {
      const result = await rail({ fetch: mockFetch(sendBlock({ confirmed: 'false' })) })
        .verify(req({ 'x-nano-block': HASH }), { usd: 5 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects a send to another address', async () => {
      const result = await rail({ fetch: mockFetch(sendBlock({}, { link_as_account: BURN })) })
        .verify(req({ 'x-nano-block': HASH }), { usd: 5 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects a receive block', async () => {
      const result = await rail({ fetch: mockFetch(sendBlock({ subtype: 'receive' })) })
        .verify(req({ 'x-nano-block': HASH }), { usd: 5 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects a block older than maxBlockAgeSeconds', async () => {
      const old = String(Math.floor(Date.now() / 1000) - 7200)
      const result = await rail({ fetch: mockFetch(sendBlock({ local_timestamp: old })) })
        .verify(req({ 'x-nano-block': HASH }), { usd: 5 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects a malformed hash without calling the RPC', async () => {
      const fetchFn = mockFetch(sendBlock())
      for (const bad of ['', 'xyz', 'A'.repeat(63), 'G'.repeat(64), 'A'.repeat(65)]) {
        const result = await rail({ fetch: fetchFn }).verify(req({ 'x-nano-block': bad }), { usd: 5 })
        expect(result.authenticated).toBe(false)
      }
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('rejects when the block is not found', async () => {
      const result = await rail({ fetch: mockFetch(undefined) }).verify(req({ 'x-nano-block': HASH }), { usd: 5 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects on an RPC HTTP error', async () => {
      const result = await rail({ fetch: mockFetch(sendBlock(), { status: 500 }) })
        .verify(req({ 'x-nano-block': HASH }), { usd: 5 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects when the RPC throws', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch
      const result = await rail({ fetch: fetchFn }).verify(req({ 'x-nano-block': HASH }), { usd: 5 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects when the route has no USD price', async () => {
      const fetchFn = mockFetch(sendBlock())
      const result = await rail({ fetch: fetchFn }).verify(req({ 'x-nano-block': HASH }), { sats: 100 })
      expect(result.authenticated).toBe(false)
      expect(fetchFn).not.toHaveBeenCalled()
    })
  })
})
