import { describe, it, expect, vi } from 'vitest'
import { createX402Rail } from './x402-rail.js'
import type { X402Facilitator, X402ChallengeWire, X402PaymentWire } from './x402-types.js'
import { X402_VERSION } from './x402-types.js'
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

/** Encode a v2 PAYMENT-SIGNATURE header value. */
function encodeV2Payment(overrides?: Partial<{
  signature: string; from: string; to: string; value: string;
  nonce: string; network: string; version: number
}>): string {
  const wire: X402PaymentWire = {
    x402Version: overrides?.version ?? X402_VERSION,
    accepted: {
      scheme: 'exact',
      network: overrides?.network ?? 'base',
      amount: overrides?.value ?? '500',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0xreceiver',
      maxTimeoutSeconds: 3600,
      extra: {},
    },
    payload: {
      signature: overrides?.signature ?? '0xsig',
      authorization: {
        from: overrides?.from ?? '0xsender',
        to: overrides?.to ?? '0xreceiver',
        value: overrides?.value ?? '500',
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 3600),
        nonce: overrides?.nonce ?? '0xnonce1',
      },
    },
  }
  return Buffer.from(JSON.stringify(wire)).toString('base64')
}

describe('X402Rail', () => {
  describe('detect', () => {
    it('returns true when payment-signature header present (v2)', () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver', network: 'base', facilitator: mockFacilitator(),
      })
      expect(rail.detect(makeRequest({ 'payment-signature': encodeV2Payment() }))).toBe(true)
    })

    it('returns true when x-payment header present (legacy)', () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver', network: 'base', facilitator: mockFacilitator(),
      })
      expect(rail.detect(makeRequest({ 'x-payment': '{}' }))).toBe(true)
    })

    it('returns false when no payment header', () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver', network: 'base', facilitator: mockFacilitator(),
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
    it('emits Payment-Required header with base64-encoded v2 JSON', async () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
        facilitatorUrl: 'https://x402.org/facilitator',
      })
      const fragment = await rail.challenge('/api/test', { usd: 5 })

      // Header is base64-encoded JSON
      const encoded = fragment.headers['Payment-Required']
      expect(encoded).toBeDefined()
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString()) as X402ChallengeWire
      expect(decoded.x402Version).toBe(X402_VERSION)
      expect(decoded.accepts).toHaveLength(1)
      expect(decoded.accepts[0].scheme).toBe('exact')
      expect(decoded.accepts[0].network).toBe('base')
      expect(decoded.accepts[0].amount).toBe('5')
      expect(decoded.accepts[0].payTo).toBe('0xreceiver')
      expect(decoded.accepts[0].asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
      expect(decoded.accepts[0].maxTimeoutSeconds).toBe(3600)
      expect(decoded.accepts[0].extra.facilitatorUrl).toBe('https://x402.org/facilitator')
      expect(decoded.resource?.url).toBe('/api/test')
    })

    it('includes human-readable body for backward compat', async () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
      })
      const fragment = await rail.challenge('/api/test', { usd: 5 })
      const x402 = fragment.body.x402 as Record<string, unknown>
      expect(x402.receiver).toBe('0xreceiver')
      expect(x402.network).toBe('base')
      expect(x402.amount_usd).toBe(5)
      expect(x402.version).toBe(X402_VERSION)
    })

    it('uses custom maxTimeoutSeconds', async () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
        maxTimeoutSeconds: 60,
      })
      const fragment = await rail.challenge('/api/test', { usd: 5 })
      const decoded = JSON.parse(Buffer.from(fragment.headers['Payment-Required'], 'base64').toString()) as X402ChallengeWire
      expect(decoded.accepts[0].maxTimeoutSeconds).toBe(60)
    })
  })

  describe('verify (v2 PAYMENT-SIGNATURE)', () => {
    it('verifies valid v2 payment and normalises to internal format', async () => {
      const storage = memoryStorage()
      const facilitator = mockFacilitator()
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator,
        creditMode: true,
        storage,
      })

      const result = await rail.verify(makeRequest({
        'payment-signature': encodeV2Payment(),
      }), { usd: 500 })

      expect(result.authenticated).toBe(true)
      expect(result.paymentId).toBe('0xabc123')
      expect(result.mode).toBe('credit')
      expect(result.creditBalance).toBe(500)
      expect(result.currency).toBe('usd')

      // Facilitator received normalised flat payload plus the advertised requirements
      expect(facilitator.verify).toHaveBeenCalledWith(expect.objectContaining({
        signature: '0xsig',
        sender: '0xsender',
        amount: 500,
        network: 'base',
        nonce: '0xnonce1',
      }), expect.objectContaining({
        scheme: 'exact',
        network: 'base',
        amount: '500',
        payTo: '0xreceiver',
      }))
    })

    it('rejects malformed base64 in payment-signature', async () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
      })
      const result = await rail.verify(makeRequest({ 'payment-signature': 'not-valid-base64!!!' }), { usd: 500 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects v2 payload missing authorization', async () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
      })
      const wire = { x402Version: 2, payload: { signature: 'sig' } }
      const encoded = Buffer.from(JSON.stringify(wire)).toString('base64')
      const result = await rail.verify(makeRequest({ 'payment-signature': encoded }), { usd: 500 })
      expect(result.authenticated).toBe(false)
    })
  })

  describe('verify (legacy X-Payment)', () => {
    it('verifies valid legacy payment (credit mode) and persists credits', async () => {
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
      const result = await rail.verify(makeRequest({ 'x-payment': payload }), { usd: 500 })

      expect(result.authenticated).toBe(true)
      expect(result.paymentId).toBe('0xabc123')
      expect(result.mode).toBe('credit')
      expect(result.creditBalance).toBe(500)
      expect(result.currency).toBe('usd')
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
      const result = await rail.verify(makeRequest({ 'x-payment': payload }), { usd: 500 })

      expect(result.authenticated).toBe(true)
      expect(result.creditBalance).toBe(500)
    })

    it('verifies valid payment (per-request mode)', async () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
        creditMode: false,
      })

      const payload = JSON.stringify({
        signature: 'sig', sender: '0xs', amount: 500, network: 'base', nonce: 'n1',
      })
      const result = await rail.verify(makeRequest({ 'x-payment': payload }), { usd: 500 })
      expect(result.mode).toBe('per-request')
      expect(result.creditBalance).toBeUndefined()
    })

    it('rejects invalid payment', async () => {
      const facilitator: X402Facilitator = {
        verify: vi.fn().mockResolvedValue({ valid: false, txHash: '', amount: 0, sender: '' }),
      }
      const rail = createX402Rail({
        receiverAddress: '0xreceiver', network: 'base', facilitator,
      })

      const payload = JSON.stringify({
        signature: 'bad', sender: '0xs', amount: 500, network: 'base', nonce: 'n1',
      })
      const result = await rail.verify(makeRequest({ 'x-payment': payload }), { usd: 500 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects when facilitator throws', async () => {
      const facilitator: X402Facilitator = {
        verify: vi.fn().mockRejectedValue(new Error('network timeout')),
      }
      const rail = createX402Rail({
        receiverAddress: '0xreceiver', network: 'base', facilitator,
      })

      const payload = JSON.stringify({
        signature: 'sig', sender: '0xs', amount: 500, network: 'base', nonce: 'n1',
      })
      const result = await rail.verify(makeRequest({ 'x-payment': payload }), { usd: 500 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects malformed x-payment header', async () => {
      const rail = createX402Rail({
        receiverAddress: '0xreceiver', network: 'base', facilitator: mockFacilitator(),
      })
      const result = await rail.verify(makeRequest({ 'x-payment': 'not-json' }), { usd: 500 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects x-payment missing required fields without calling facilitator', async () => {
      const facilitator = mockFacilitator()
      const rail = createX402Rail({
        receiverAddress: '0xreceiver', network: 'base', facilitator,
      })

      const incomplete = JSON.stringify({ sender: '0xs', amount: 500, network: 'base', nonce: 'n1' })
      const result = await rail.verify(makeRequest({ 'x-payment': incomplete }), { usd: 500 })
      expect(result.authenticated).toBe(false)
      expect(facilitator.verify).not.toHaveBeenCalled()
    })

    it('rejects x-payment with non-positive amount without calling facilitator', async () => {
      const facilitator = mockFacilitator()
      const rail = createX402Rail({
        receiverAddress: '0xreceiver', network: 'base', facilitator,
      })

      const negativeAmount = JSON.stringify({
        signature: 'sig', sender: '0xs', amount: -100, network: 'base', nonce: 'n1',
      })
      const result = await rail.verify(makeRequest({ 'x-payment': negativeAmount }), { usd: 500 })
      expect(result.authenticated).toBe(false)
      expect(facilitator.verify).not.toHaveBeenCalled()
    })

    it('rejects x-payment with non-finite amount', async () => {
      const facilitator = mockFacilitator()
      const rail = createX402Rail({
        receiverAddress: '0xreceiver', network: 'base', facilitator,
      })

      const result = await rail.verify(makeRequest({
        'x-payment': '{"signature":"sig","sender":"0xs","amount":"NaN","network":"base","nonce":"n1"}',
      }), { usd: 500 })
      expect(result.authenticated).toBe(false)
      expect(facilitator.verify).not.toHaveBeenCalled()
    })
  })

  describe('v2 takes precedence over legacy', () => {
    it('prefers payment-signature over x-payment when both present', async () => {
      const facilitator = mockFacilitator()
      const rail = createX402Rail({
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator,
        creditMode: false,
      })

      const v2Header = encodeV2Payment({ from: '0xv2sender', value: '500' })
      const legacyHeader = JSON.stringify({
        signature: 'legacy', sender: '0xlegacy', amount: 100, network: 'base', nonce: 'n',
      })

      await rail.verify(makeRequest({
        'payment-signature': v2Header,
        'x-payment': legacyHeader,
      }), { usd: 500 })

      // Should have used the v2 sender, not the legacy one
      expect(facilitator.verify).toHaveBeenCalledWith(expect.objectContaining({
        sender: '0xv2sender',
      }), expect.anything())
    })
  })

  describe('payment requirements enforcement', () => {
    const makeRail = (facilitator: X402Facilitator) => createX402Rail({
      receiverAddress: '0xreceiver', network: 'base', facilitator,
    })

    it('rejects a validly signed underpayment (1-cent transfer on a $10 route)', async () => {
      const facilitator = mockFacilitator({ amount: 1 })
      const rail = makeRail(facilitator)

      const payload = JSON.stringify({
        signature: 'sig', sender: '0xs', amount: 1, network: 'base', nonce: 'n1',
      })
      const result = await rail.verify(makeRequest({ 'x-payment': payload }), { usd: 1000 })
      expect(result.authenticated).toBe(false)
      // Underpayment must never reach the facilitator
      expect(facilitator.verify).not.toHaveBeenCalled()
    })

    it('rejects an attacker-controlled network that does not match requirements', async () => {
      const facilitator = mockFacilitator()
      const rail = makeRail(facilitator)

      const result = await rail.verify(makeRequest({
        'payment-signature': encodeV2Payment({ network: 'base-sepolia' }),
      }), { usd: 500 })
      expect(result.authenticated).toBe(false)
      expect(facilitator.verify).not.toHaveBeenCalled()
    })

    it('rejects when the facilitator reports a settled amount below the price', async () => {
      const facilitator = mockFacilitator({ amount: 1 })
      const rail = makeRail(facilitator)

      // Payload claims the full price, but the facilitator settled less
      const result = await rail.verify(makeRequest({
        'payment-signature': encodeV2Payment(),
      }), { usd: 1000 })
      // Payload amount (500) is also below price — rejected before facilitator
      expect(result.authenticated).toBe(false)
    })

    it('rejects when the facilitator verifies but settles less than the price', async () => {
      const facilitator = mockFacilitator({ amount: 400 })
      const rail = makeRail(facilitator)

      const result = await rail.verify(makeRequest({
        'payment-signature': encodeV2Payment(),
      }), { usd: 500 })
      expect(result.authenticated).toBe(false)
      expect(facilitator.verify).toHaveBeenCalled()
    })

    it('rejects a payTo that does not match the receiver', async () => {
      const facilitator = mockFacilitator()
      const rail = makeRail(facilitator)

      const wire: X402PaymentWire = {
        x402Version: X402_VERSION,
        accepted: {
          scheme: 'exact',
          network: 'base',
          amount: '500',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          payTo: '0xattacker',
          maxTimeoutSeconds: 3600,
          extra: {},
        },
        payload: {
          signature: '0xsig',
          authorization: {
            from: '0xsender', to: '0xattacker', value: '500',
            validAfter: '0', validBefore: '9999999999', nonce: '0xnonce1',
          },
        },
      }
      const header = Buffer.from(JSON.stringify(wire)).toString('base64')
      const result = await rail.verify(makeRequest({ 'payment-signature': header }), { usd: 500 })
      expect(result.authenticated).toBe(false)
      expect(facilitator.verify).not.toHaveBeenCalled()
    })

    it('fails closed when no price is provided', async () => {
      const facilitator = mockFacilitator()
      const rail = makeRail(facilitator)

      const result = await rail.verify(makeRequest({
        'payment-signature': encodeV2Payment(),
      }))
      expect(result.authenticated).toBe(false)
      expect(facilitator.verify).not.toHaveBeenCalled()
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
