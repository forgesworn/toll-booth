import { describe, it, expect, vi } from 'vitest'
import { Booth } from '../booth.js'
import { memoryStorage } from '../storage/memory.js'
import type { X402Facilitator } from '../core/x402-types.js'

const ADDRESS = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3'
const PAYER = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp'
const HASH = 'B'.repeat(64)
const RATE = 10n ** 24n

function x402Facilitator(): X402Facilitator {
  return { verify: vi.fn().mockResolvedValue({ valid: false, txHash: '', amount: 0, sender: '' }) }
}

/** Mock node RPC answering blocks_info with one confirmed send of `amount` raw. */
function nodeRpc(amount: bigint) {
  return vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const { hashes } = JSON.parse(String(init?.body)) as { hashes: string[] }
    return new Response(JSON.stringify({
      blocks: {
        [hashes[0]]: {
          block_account: PAYER,
          amount: amount.toString(),
          local_timestamp: String(Math.floor(Date.now() / 1000)),
          confirmed: 'true',
          subtype: 'send',
          contents: { type: 'state', account: PAYER, link_as_account: ADDRESS },
        },
      },
    }))
  }) as unknown as typeof fetch
}

function makeBooth(fetchFn: typeof fetch) {
  return new Booth({
    adapter: 'express',
    upstream: 'http://localhost:3000',
    pricing: { '/api/test': { sats: 100, usd: 5 }, '/api/sats': 100 },
    storage: memoryStorage(),
    serviceName: 'test',
    x402: { receiverAddress: '0xreceiver', network: 'base', facilitator: x402Facilitator() },
    nano: { address: ADDRESS, rawPerCent: RATE, fetch: fetchFn },
  })
}

function request(path: string, headers: Record<string, string> = {}) {
  return { method: 'GET', path, headers, ip: '127.0.0.1' }
}

describe('Nano integration flow', () => {
  it('advertises a Nano payment beside x402 in the 402 challenge', async () => {
    const booth = makeBooth(nodeRpc(5n * RATE))
    const result = await booth['engine'].handle(request('/api/test'))
    expect(result.action).toBe('challenge')
    if (result.action === 'challenge') {
      expect(result.status).toBe(402)
      expect(result.headers['Payment-Required']).toBeDefined()
      expect(result.headers['X-Nano']).toBe(`nano:${ADDRESS}?amount=${5n * RATE}`)
      expect(result.body.nano).toMatchObject({ address: ADDRESS, amount_raw: (5n * RATE).toString() })
      expect(result.body.auth_hint).toEqual(expect.arrayContaining([expect.stringContaining('X-Nano-Block')]))
    }
    booth.close()
  })

  it('does not advertise Nano on a sats-only route', async () => {
    const booth = makeBooth(nodeRpc(5n * RATE))
    const result = await booth['engine'].handle(request('/api/sats'))
    expect(result.action).toBe('challenge')
    if (result.action === 'challenge') {
      expect(result.body.nano).toBeUndefined()
      expect(result.headers['X-Nano']).toBeUndefined()
    }
    booth.close()
  })

  it('admits a confirmed send block once and refuses its replay', async () => {
    const fetchFn = nodeRpc(5n * RATE)
    const booth = makeBooth(fetchFn)

    const first = await booth['engine'].handle(request('/api/test', { 'x-nano-block': HASH }))
    expect(first.action).toBe('proxy')
    expect(fetchFn).toHaveBeenCalledTimes(1)

    const replay = await booth['engine'].handle(request('/api/test', { 'x-nano-block': HASH }))
    expect(replay.action).toBe('challenge')

    const caseVariant = await booth['engine'].handle(request('/api/test', { 'x-nano-block': HASH.toLowerCase() }))
    expect(caseVariant.action).toBe('challenge')
    booth.close()
  })

  it('refuses an underpaying block', async () => {
    const booth = makeBooth(nodeRpc(5n * RATE - 1n))
    const result = await booth['engine'].handle(request('/api/test', { 'x-nano-block': HASH }))
    expect(result.action).toBe('challenge')
    booth.close()
  })

  it('works as the only payment method', async () => {
    const booth = new Booth({
      adapter: 'web-standard',
      upstream: 'http://localhost:3000',
      pricing: { '/api/test': { usd: 5 } },
      storage: memoryStorage(),
      nano: { address: ADDRESS, rawPerCent: RATE, fetch: nodeRpc(5n * RATE) },
    })
    const result = await booth['engine'].handle(request('/api/test', { 'x-nano-block': HASH }))
    expect(result.action).toBe('proxy')
    booth.close()
  })
})
