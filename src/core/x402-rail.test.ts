import { describe, it, expect, vi } from 'vitest'
import { createX402Rail } from './x402-rail.js'
import type { X402Facilitator } from './x402-types.js'
import { memoryStorage } from '../storage/memory.js'

function mockFacilitator(overrides?: Partial<{ valid: boolean; txHash: string; amount: number; sender: string }>): X402Facilitator {
  return {
    verify: vi.fn().mockResolvedValue({
      valid: true,
      txHash: '0xabc123',
      amount: 500,
      sender: '0xsender',
      ...overrides,
    }),
  }
}

function makeRequest(headers: Record<string, string | undefined> = {}) {
  return { method: 'POST', path: '/api/test', headers, ip: '127.0.0.1' }
}

describe('X402Rail', () => {
  describe('detect', () => {
    it('returns true when x-payment header present', () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
      })
      expect(rail.detect(makeRequest({ 'x-payment': '{}' }))).toBe(true)
    })

    it('returns false when no x-payment header', () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
      })
      expect(rail.detect(makeRequest())).toBe(false)
    })
  })

  describe('canChallenge', () => {
    it('returns true when price has usd', () => {
      const rail = createX402Rail({
        receiverAddress: '0x', network: 'base', facilitator: mockFacilitator(),
      })
      expect(rail.canChallenge!({ usd: 5 })).toBe(true)
    })

    it('returns false when price has only sats', () => {
      const rail = createX402Rail({
        receiverAddress: '0x', network: 'base', facilitator: mockFacilitator(),
      })
      expect(rail.canChallenge!({ sats: 100 })).toBe(false)
    })

    it('returns false for empty price', () => {
      const rail = createX402Rail({
        receiverAddress: '0x', network: 'base', facilitator: mockFacilitator(),
      })
      expect(rail.canChallenge!({})).toBe(false)
    })
  })

  describe('challenge', () => {
    it('returns x402 payment requirements', async () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
        facilitatorUrl: 'https://x402.org/facilitator',
      })
      const fragment = await rail.challenge('/api/test', { usd: 5 })
      expect(fragment.headers['X-Payment-Required']).toBe('x402')
      const x402 = fragment.body.x402 as Record<string, unknown>
      expect(x402.receiver).toBe('0xreceiver')
      expect(x402.network).toBe('base')
      expect(x402.amount_usd).toBe(5)
      expect(x402.asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
    })
  })

  describe('verify', () => {
    it('verifies valid x402 payment (credit mode) and persists credits', async () => {
      const storage = memoryStorage()
      const facilitator = mockFacilitator()
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator,
        creditMode: true,
        storage,
      })

      const payload = JSON.stringify({
        signature: 'sig', sender: '0xs', amount: 500, network: 'base', nonce: 'n1',
      })
      const result = await rail.verify(makeRequest({ 'x-payment': payload }))

      expect(result.authenticated).toBe(true)
      expect(result.paymentId).toBe('0xabc123')
      expect(result.mode).toBe('credit')
      expect(result.creditBalance).toBe(500)
      expect(result.currency).toBe('usd')

      // Credits persisted to storage in USD
      expect(storage.balance('0xabc123', 'usd')).toBe(500)
      expect(storage.isSettled('0xabc123')).toBe(true)
    })

    it('credit mode without storage still returns creditBalance from facilitator', async () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
        creditMode: true,
      })

      const payload = JSON.stringify({
        signature: 'sig', sender: '0xs', amount: 500, network: 'base', nonce: 'n1',
      })
      const result = await rail.verify(makeRequest({ 'x-payment': payload }))

      expect(result.authenticated).toBe(true)
      expect(result.creditBalance).toBe(500)
    })

    it('verifies valid x402 payment (per-request mode)', async () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
        creditMode: false,
      })

      const payload = JSON.stringify({
        signature: 'sig', sender: '0xs', amount: 500, network: 'base', nonce: 'n1',
      })
      const result = await rail.verify(makeRequest({ 'x-payment': payload }))

      expect(result.mode).toBe('per-request')
      expect(result.creditBalance).toBeUndefined()
    })

    it('rejects invalid payment', async () => {
      const facilitator: X402Facilitator = {
        verify: vi.fn().mockResolvedValue({ valid: false, txHash: '', amount: 0, sender: '' }),
      }
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator,
      })

      const payload = JSON.stringify({
        signature: 'bad', sender: '0xs', amount: 500, network: 'base', nonce: 'n1',
      })
      const result = await rail.verify(makeRequest({ 'x-payment': payload }))

      expect(result.authenticated).toBe(false)
    })

    it('rejects when facilitator throws', async () => {
      const facilitator: X402Facilitator = {
        verify: vi.fn().mockRejectedValue(new Error('network timeout')),
      }
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator,
      })

      const payload = JSON.stringify({
        signature: 'sig', sender: '0xs', amount: 500, network: 'base', nonce: 'n1',
      })
      const result = await rail.verify(makeRequest({ 'x-payment': payload }))
      expect(result.authenticated).toBe(false)
    })

    it('rejects malformed x-payment header', async () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
      })

      const result = await rail.verify(makeRequest({ 'x-payment': 'not-json' }))
      expect(result.authenticated).toBe(false)
    })
  })

  describe('properties', () => {
    it('type is x402', () => {
      const rail = createX402Rail({
        receiverAddress: '0x', network: 'base', facilitator: mockFacilitator(),
      })
      expect(rail.type).toBe('x402')
    })

    it('creditSupported is true', () => {
      const rail = createX402Rail({
        receiverAddress: '0x', network: 'base', facilitator: mockFacilitator(),
      })
      expect(rail.creditSupported).toBe(true)
    })
  })
})
