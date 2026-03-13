import { describe, it, expect, vi } from 'vitest'
import { Booth } from '../booth.js'
import { memoryStorage } from '../storage/memory.js'
import type { X402Facilitator } from '../core/x402-types.js'

function mockFacilitator(): X402Facilitator {
  return {
    verify: vi.fn().mockResolvedValue({
      valid: true,
      txHash: '0x' + 'a'.repeat(62),
      amount: 500,
      sender: '0xsender',
    }),
  }
}

describe('x402 integration flow', () => {
  it('returns 402 with x402 payment requirements', async () => {
    // x402-only booth (no Lightning)
    const booth = new Booth({
      adapter: 'express',
      upstream: 'http://localhost:3000',
      pricing: { '/api/test': { sats: 100, usd: 5 } },
      storage: memoryStorage(),
      x402: {
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
      },
    })

    // Use engine directly to test
    const result = await booth['engine'].handle({
      method: 'GET', path: '/api/test',
      headers: {}, ip: '127.0.0.1',
    })

    expect(result.action).toBe('challenge')
    if (result.action === 'challenge') {
      expect(result.status).toBe(402)
      const x402 = result.body.x402 as Record<string, unknown>
      expect(x402).toBeDefined()
      expect(x402.receiver).toBe('0xreceiver')
      expect(x402.network).toBe('base')
      expect(x402.amount_usd).toBe(5)
    }

    booth.close()
  })

  it('rejects replayed x402 payment in per-request mode', async () => {
    const facilitator = mockFacilitator()
    const booth = new Booth({
      adapter: 'express',
      upstream: 'http://localhost:3000',
      pricing: { '/api/test': { sats: 100, usd: 5 } },
      storage: memoryStorage(),
      x402: {
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator,
        creditMode: false,
      },
    })

    const payload = JSON.stringify({
      signature: 'sig', sender: '0xs', amount: 500, network: 'base', nonce: 'n1',
    })

    // First request — should succeed
    const result1 = await booth['engine'].handle({
      method: 'GET', path: '/api/test',
      headers: { 'x-payment': payload }, ip: '127.0.0.1',
    })
    expect(result1.action).toBe('proxy')

    // Replay — should be rejected (falls through to challenge)
    const result2 = await booth['engine'].handle({
      method: 'GET', path: '/api/test',
      headers: { 'x-payment': payload }, ip: '127.0.0.1',
    })
    expect(result2.action).toBe('challenge')

    booth.close()
  })

  it('x402 credit mode: pays once, debits across multiple requests', async () => {
    const facilitator = mockFacilitator()
    const booth = new Booth({
      adapter: 'express',
      upstream: 'http://localhost:3000',
      pricing: { '/api/test': { sats: 100, usd: 5 } },
      storage: memoryStorage(),
      x402: {
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator,
        creditMode: true,
      },
    })

    const payload = JSON.stringify({
      signature: 'sig', sender: '0xs', amount: 500, network: 'base', nonce: 'n1',
    })

    // First request with x-payment — should settle credits and debit
    const result1 = await booth['engine'].handle({
      method: 'GET', path: '/api/test',
      headers: { 'x-payment': payload }, ip: '127.0.0.1',
    })
    expect(result1.action).toBe('proxy')
    if (result1.action === 'proxy') {
      expect(result1.creditBalance).toBe(495) // 500 - 5
    }

    // Second request — same payment, credits already settled, debit again
    const result2 = await booth['engine'].handle({
      method: 'GET', path: '/api/test',
      headers: { 'x-payment': payload }, ip: '127.0.0.1',
    })
    expect(result2.action).toBe('proxy')
    if (result2.action === 'proxy') {
      expect(result2.creditBalance).toBe(490) // 495 - 5
    }

    booth.close()
  })
})
