import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createXCashuRail } from './xcashu-rail.js'
import type { TollBoothRequest } from './types.js'

function makeReq(headers: Record<string, string | undefined> = {}, path = '/api'): TollBoothRequest {
  return {
    method: 'GET',
    path,
    headers,
    ip: '127.0.0.1',
  }
}

describe('xcashu-rail', () => {
  const config = {
    mints: ['https://mint.example.com'],
    unit: 'sat' as const,
  }

  describe('type and flags', () => {
    it('has type xcashu', () => {
      const rail = createXCashuRail(config)
      expect(rail.type).toBe('xcashu')
    })

    it('supports credit mode', () => {
      const rail = createXCashuRail(config)
      expect(rail.creditSupported).toBe(true)
    })
  })

  describe('canChallenge', () => {
    it('returns true when price has sats', () => {
      const rail = createXCashuRail(config)
      expect(rail.canChallenge!({ sats: 10 })).toBe(true)
    })

    it('returns false when price has only usd', () => {
      const rail = createXCashuRail(config)
      expect(rail.canChallenge!({ usd: 100 })).toBe(false)
    })

    it('returns true when price has both sats and usd', () => {
      const rail = createXCashuRail(config)
      expect(rail.canChallenge!({ sats: 10, usd: 1 })).toBe(true)
    })
  })

  describe('detect', () => {
    it('detects X-Cashu header with cashuB prefix', () => {
      const rail = createXCashuRail(config)
      expect(rail.detect(makeReq({ 'x-cashu': 'cashuBsometoken' }))).toBe(true)
    })

    it('does not detect X-Cashu header with creqA prefix (payment request)', () => {
      const rail = createXCashuRail(config)
      expect(rail.detect(makeReq({ 'x-cashu': 'creqAsomerequest' }))).toBe(false)
    })

    it('does not detect missing header', () => {
      const rail = createXCashuRail(config)
      expect(rail.detect(makeReq())).toBe(false)
    })

    it('does not detect empty header', () => {
      const rail = createXCashuRail(config)
      expect(rail.detect(makeReq({ 'x-cashu': '' }))).toBe(false)
    })
  })

  describe('challenge', () => {
    it('returns X-Cashu header with encoded payment request', async () => {
      const rail = createXCashuRail(config)
      const fragment = await rail.challenge('/api', { sats: 10 })
      expect(fragment.headers).toHaveProperty('X-Cashu')
      const header = fragment.headers['X-Cashu']
      expect(typeof header).toBe('string')
      expect(header.length).toBeGreaterThan(0)
    })

    it('includes amount and mints in challenge body', async () => {
      const rail = createXCashuRail(config)
      const fragment = await rail.challenge('/api', { sats: 10 })
      expect(fragment.body).toMatchObject({
        xcashu: {
          amount: 10,
          unit: 'sat',
          mints: ['https://mint.example.com'],
        },
      })
    })
  })

  describe('verify', () => {
    it('rejects malformed token', async () => {
      const rail = createXCashuRail(config)
      const result = await rail.verify(makeReq({ 'x-cashu': 'cashuBnotavalidtoken' }))
      expect(result.authenticated).toBe(false)
    })

    it('rejects missing header', async () => {
      const rail = createXCashuRail(config)
      const result = await rail.verify(makeReq())
      expect(result.authenticated).toBe(false)
    })
  })
})

// ── Mocked verify tests ────────────────────────────────────────────────

vi.mock('@cashu/cashu-ts', () => {
  const getDecodedToken = vi.fn().mockImplementation(() => {
    throw new Error('Invalid token')
  })
  const Wallet = vi.fn()
  const Mint = vi.fn(() => ({}))
  return { getDecodedToken, Wallet, Mint }
})

describe('xcashu-rail verify (mocked)', () => {
  const config = {
    mints: ['https://mint.example.com'],
    unit: 'sat' as const,
  }

  let mockGetDecodedToken: ReturnType<typeof vi.fn>
  let MockWallet: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()

    const cashuTs = await import('@cashu/cashu-ts')
    mockGetDecodedToken = vi.mocked(cashuTs.getDecodedToken)
    MockWallet = vi.mocked(cashuTs.Wallet)

    // Default: valid decoded token from accepted mint
    mockGetDecodedToken.mockReturnValue({
      mint: 'https://mint.example.com',
      unit: 'sat',
      proofs: [{ amount: 10, id: 'key1', C: 'sig1', secret: 's1' }],
    })

    // Default: wallet that successfully receives proofs
    const mockWalletInstance = {
      loadMint: vi.fn().mockResolvedValue(undefined),
      receive: vi.fn().mockResolvedValue([{ amount: 10 }]),
    }
    MockWallet.mockImplementation(() => mockWalletInstance)
  })

  it('verify success path returns authenticated with credit', async () => {
    const { createXCashuRail } = await import('./xcashu-rail.js')
    const rail = createXCashuRail(config)
    const result = await rail.verify(makeReq({ 'x-cashu': 'cashuBvalidtoken' }))

    expect(result.authenticated).toBe(true)
    expect(result.paymentId).toMatch(/^[0-9a-f]{64}$/)
    expect(result.mode).toBe('credit')
    expect(result.currency).toBe('sat')
    expect(result.creditBalance).toBe(10)
  })

  it('verify settles to storage', async () => {
    const mockStorage = {
      settleWithCredit: vi.fn().mockReturnValue(true),
      isSettled: vi.fn().mockReturnValue(false),
    } as any

    const { createXCashuRail } = await import('./xcashu-rail.js')
    const rail = createXCashuRail(config, mockStorage)
    const result = await rail.verify(makeReq({ 'x-cashu': 'cashuBvalidtoken' }))

    expect(result.authenticated).toBe(true)
    expect(mockStorage.settleWithCredit).toHaveBeenCalledOnce()

    const args = mockStorage.settleWithCredit.mock.calls[0]
    expect(args[0]).toMatch(/^[0-9a-f]{64}$/) // paymentId
    expect(args[1]).toBe(10) // amount
    expect(args[2]).toMatch(/^[0-9a-f]{64}$/) // settlementSecret
    expect(args[3]).toBe('sat') // currency
  })

  it('rejects wrong mint in decoded token', async () => {
    mockGetDecodedToken.mockReturnValue({
      mint: 'https://wrong.mint',
      unit: 'sat',
      proofs: [{ amount: 10, id: 'key1', C: 'sig1', secret: 's1' }],
    })

    const { createXCashuRail } = await import('./xcashu-rail.js')
    const rail = createXCashuRail(config)
    const result = await rail.verify(makeReq({ 'x-cashu': 'cashuBvalidtoken' }))

    expect(result.authenticated).toBe(false)
  })

  it('rejects unit mismatch in decoded token', async () => {
    mockGetDecodedToken.mockReturnValue({
      mint: 'https://mint.example.com',
      unit: 'usd',
      proofs: [{ amount: 100, id: 'key1', C: 'sig1', secret: 's1' }],
    })

    const { createXCashuRail } = await import('./xcashu-rail.js')
    const rail = createXCashuRail(config)
    const result = await rail.verify(makeReq({ 'x-cashu': 'cashuBvalidtoken' }))

    expect(result.authenticated).toBe(false)
  })
})
