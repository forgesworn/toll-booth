import { describe, it, expect, vi } from 'vitest'
import { createL402Rail } from './l402-rail.js'
import { mintMacaroon } from '../macaroon.js'
import { createHash, randomBytes } from 'node:crypto'

function makePreimageAndHash() {
  const preimage = randomBytes(32).toString('hex')
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
  return { preimage, paymentHash }
}

const ROOT_KEY = randomBytes(32).toString('hex')

describe('L402Rail', () => {
  describe('detect', () => {
    it('returns true for L402 Authorization header', () => {
      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage: mockStorage(),
        defaultAmount: 1000,
      })
      const req = makeRequest({ authorization: 'L402 abc:def' })
      expect(rail.detect(req)).toBe(true)
    })

    it('returns true case-insensitively', () => {
      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage: mockStorage(),
        defaultAmount: 1000,
      })
      const req = makeRequest({ authorization: 'l402 abc:def' })
      expect(rail.detect(req)).toBe(true)
    })

    it('returns false for missing Authorization header', () => {
      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage: mockStorage(),
        defaultAmount: 1000,
      })
      const req = makeRequest({})
      expect(rail.detect(req)).toBe(false)
    })

    it('returns false for Bearer token', () => {
      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage: mockStorage(),
        defaultAmount: 1000,
      })
      const req = makeRequest({ authorization: 'Bearer xyz' })
      expect(rail.detect(req)).toBe(false)
    })
  })

  describe('canChallenge', () => {
    it('returns true when price has sats', () => {
      const rail = createL402Rail({ rootKey: ROOT_KEY, storage: mockStorage(), defaultAmount: 1000 })
      expect(rail.canChallenge!({ sats: 100 })).toBe(true)
    })

    it('returns false when price has only usd', () => {
      const rail = createL402Rail({ rootKey: ROOT_KEY, storage: mockStorage(), defaultAmount: 1000 })
      expect(rail.canChallenge!({ usd: 100 })).toBe(false)
    })
  })

  describe('verify', () => {
    it('verifies valid L402 credential and returns creditBalance', () => {
      const { preimage, paymentHash } = makePreimageAndHash()
      const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
      const storage = mockStorage()
      storage.isSettled.mockReturnValue(false)
      storage.settleWithCredit.mockReturnValue(true)
      storage.balance.mockReturnValue(1000)

      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage,
        defaultAmount: 1000,
      })

      const req = makeRequest({ authorization: `L402 ${macaroon}:${preimage}` })
      const result = rail.verify(req)

      expect(result.authenticated).toBe(true)
      expect(result.paymentId).toBe(paymentHash)
      expect(result.mode).toBe('credit')
      expect(result.currency).toBe('sat')
      expect(result.creditBalance).toBe(1000)
    })

    it('never calls storage.debit', () => {
      const { preimage, paymentHash } = makePreimageAndHash()
      const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
      const storage = mockStorage()
      storage.isSettled.mockReturnValue(false)
      storage.settleWithCredit.mockReturnValue(true)
      storage.balance.mockReturnValue(1000)

      const rail = createL402Rail({ rootKey: ROOT_KEY, storage, defaultAmount: 1000 })
      rail.verify(makeRequest({ authorization: `L402 ${macaroon}:${preimage}` }))

      expect(storage.debit).not.toHaveBeenCalled()
    })

    it('rejects invalid preimage even if payment is settled', () => {
      const { paymentHash } = makePreimageAndHash()
      const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
      const storage = mockStorage()
      storage.isSettled.mockReturnValue(true) // already settled

      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage,
        defaultAmount: 1000,
      })

      const badPreimage = randomBytes(32).toString('hex')
      const req = makeRequest({ authorization: `L402 ${macaroon}:${badPreimage}` })
      const result = rail.verify(req)

      expect(result.authenticated).toBe(false)
    })

    it('rejects malformed token without colon', () => {
      const rail = createL402Rail({ rootKey: ROOT_KEY, storage: mockStorage(), defaultAmount: 1000 })
      const req = makeRequest({ authorization: 'L402 nocolonhere' })
      const result = rail.verify(req)
      expect(result.authenticated).toBe(false)
    })

    it('authenticates with Cashu settlement secret', () => {
      const { paymentHash } = makePreimageAndHash()
      const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
      const secret = randomBytes(32).toString('hex')
      const storage = mockStorage()
      storage.getSettlementSecret.mockReturnValue(secret)
      storage.isSettled.mockReturnValue(true) // Cashu settles before L402 auth
      storage.balance.mockReturnValue(500)

      const rail = createL402Rail({ rootKey: ROOT_KEY, storage, defaultAmount: 1000 })
      const req = makeRequest({ authorization: `L402 ${macaroon}:${secret}` })
      const result = rail.verify(req)

      expect(result.authenticated).toBe(true)
      expect(result.creditBalance).toBe(500)
    })
  })

  describe('challenge', () => {
    it('generates L402 challenge with invoice and macaroon', async () => {
      const backend = {
        createInvoice: vi.fn().mockResolvedValue({
          bolt11: 'lnbc1000...',
          paymentHash: 'abc123'.padEnd(64, '0'),
        }),
        checkInvoice: vi.fn(),
      }

      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage: mockStorage(),
        defaultAmount: 1000,
        backend,
      })

      const result = await rail.challenge('/api/test', { sats: 100 })
      expect(result.headers['WWW-Authenticate']).toMatch(/^L402 /)
      expect(result.body.l402).toBeDefined()
      const l402 = result.body.l402 as Record<string, unknown>
      expect(l402.invoice).toBe('lnbc1000...')
      expect(l402.macaroon).toBeDefined()
      expect(l402.amount_sats).toBe(1000)
    })

    it('generates synthetic hash without backend (Cashu-only mode)', async () => {
      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage: mockStorage(),
        defaultAmount: 500,
      })

      const result = await rail.challenge('/api/test', { sats: 500 })
      expect(result.headers['WWW-Authenticate']).toMatch(/^L402 /)
      const l402 = result.body.l402 as Record<string, unknown>
      expect(l402.invoice).toBe('')
      expect(l402.macaroon).toBeDefined()
      expect(l402.payment_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(l402.amount_sats).toBe(500)
    })
  })
})

function mockStorage() {
  return {
    credit: vi.fn(),
    debit: vi.fn().mockReturnValue({ success: true, remaining: 0 }),
    balance: vi.fn().mockReturnValue(0),
    adjustCredits: vi.fn().mockReturnValue(0),
    settle: vi.fn().mockReturnValue(true),
    isSettled: vi.fn().mockReturnValue(false),
    settleWithCredit: vi.fn().mockReturnValue(true),
    getSettlementSecret: vi.fn().mockReturnValue(undefined),
    claimForRedeem: vi.fn().mockReturnValue(true),
    pendingClaims: vi.fn().mockReturnValue([]),
    tryAcquireRecoveryLease: vi.fn().mockReturnValue(undefined),
    extendRecoveryLease: vi.fn().mockReturnValue(true),
    storeInvoice: vi.fn(),
    pendingInvoiceCount: vi.fn().mockReturnValue(0),
    getInvoice: vi.fn().mockReturnValue(undefined),
    getInvoiceForStatus: vi.fn().mockReturnValue(undefined),
    pruneExpiredInvoices: vi.fn().mockReturnValue(0),
    pruneStaleRecords: vi.fn().mockReturnValue(0),
    close: vi.fn(),
  }
}

function makeRequest(headers: Record<string, string>) {
  return {
    method: 'GET',
    path: '/api/test',
    headers,
    ip: '127.0.0.1',
  }
}
