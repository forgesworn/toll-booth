// src/core/lnget-compat.test.ts
//
// Validates that toll-booth's L402 responses are compatible with
// Lightning Labs' lnget v1.0.0 client (https://github.com/lightninglabs/lnget).
//
// lnget parses the WWW-Authenticate header with this regex:
//   (?i)(LSAT|L402)\s+macaroon="([^"]+)",\s*invoice="([^"]+)"
//
// lnget sends back:
//   Authorization: L402 <base64_macaroon>:<hex_preimage>
//
// lnget caches one token per domain and reuses it on subsequent requests.
//
import { describe, it, expect, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createTollBooth } from './toll-booth.js'
import type { TollBoothResult } from './types.js'

/** Narrow a TollBoothResult to its challenge variant, failing the test if wrong. */
function expectChallenge(result: TollBoothResult) {
  expect(result.action).toBe('challenge')
  if (result.action !== 'challenge') throw new Error('expected challenge')
  return result
}

const ROOT_KEY = randomBytes(32).toString('hex')

/** lnget's exact regex for parsing the WWW-Authenticate header. */
const LNGET_CHALLENGE_RE = /(?:LSAT|L402)\s+macaroon="([^"]+)",\s*invoice="([^"]+)"/i

/** lnget validates preimages are exactly 64 hex chars. */
const LNGET_PREIMAGE_RE = /^[0-9a-f]{64}$/

function makePreimageAndHash() {
  const preimage = randomBytes(32).toString('hex')
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
  return { preimage, paymentHash }
}

function mockBackend(preimageMap: Map<string, string>) {
  return {
    createInvoice: vi.fn().mockImplementation((amount: number, _memo: string) => {
      const { preimage, paymentHash } = makePreimageAndHash()
      preimageMap.set(paymentHash, preimage)
      return Promise.resolve({ bolt11: `lnbc${amount}n1fake_${paymentHash.slice(0, 16)}`, paymentHash })
    }),
    checkInvoice: vi.fn().mockResolvedValue({ settled: true }),
  }
}

function mockStorage() {
  const credits = new Map<string, number>()
  const settled = new Set<string>()
  const secrets = new Map<string, string>()

  return {
    credit: vi.fn(),
    debit: vi.fn().mockImplementation((id: string, cost: number) => {
      const bal = credits.get(id) ?? 0
      if (bal < cost) return { success: false, remaining: bal }
      credits.set(id, bal - cost)
      return { success: true, remaining: bal - cost }
    }),
    balance: vi.fn().mockImplementation((id: string) => credits.get(id) ?? 0),
    adjustCredits: vi.fn().mockReturnValue(0),
    settle: vi.fn().mockImplementation((id: string) => {
      if (settled.has(id)) return false
      settled.add(id)
      return true
    }),
    isSettled: vi.fn().mockImplementation((id: string) => settled.has(id)),
    settleWithCredit: vi.fn().mockImplementation((id: string, amount: number) => {
      if (settled.has(id)) return false
      settled.add(id)
      credits.set(id, amount)
      return true
    }),
    getSettlementSecret: vi.fn().mockImplementation((id: string) => secrets.get(id)),
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

describe('lnget v1.0.0 compatibility', () => {
  describe('WWW-Authenticate header parsing', () => {
    it('challenge header matches lnget regex', async () => {
      const preimageMap = new Map<string, string>()
      const storage = mockStorage()
      const backend = mockBackend(preimageMap)

      const engine = createTollBooth({
        rootKey: ROOT_KEY,
        upstream: 'http://localhost:9999',
        pricing: { '/api/test': 100 },
        defaultInvoiceAmount: 100,
        storage,
        backend,
      })

      const result = expectChallenge(await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: {},
        ip: '10.0.0.1',
      }))

      expect(result.status).toBe(402)
      const wwwAuth = result.headers['WWW-Authenticate']
      expect(wwwAuth).toBeDefined()

      const match = LNGET_CHALLENGE_RE.exec(wwwAuth!)
      expect(match).not.toBeNull()
      expect(match![1]).toBeTruthy() // base64 macaroon
      expect(match![2]).toBeTruthy() // bolt11 invoice
    })

    it('macaroon in header is valid base64', async () => {
      const preimageMap = new Map<string, string>()
      const storage = mockStorage()
      const backend = mockBackend(preimageMap)

      const engine = createTollBooth({
        rootKey: ROOT_KEY,
        upstream: 'http://localhost:9999',
        pricing: { '/api/test': 100 },
        defaultInvoiceAmount: 100,
        storage,
        backend,
      })

      const result = expectChallenge(await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: {},
        ip: '10.0.0.1',
      }))

      const match = LNGET_CHALLENGE_RE.exec(result.headers['WWW-Authenticate']!)!
      const macaroonBase64 = match[1]

      // lnget decodes with standard base64
      expect(() => Buffer.from(macaroonBase64, 'base64')).not.toThrow()
      // Round-trip check: decoded bytes re-encode to same string
      const decoded = Buffer.from(macaroonBase64, 'base64')
      expect(decoded.toString('base64')).toBe(macaroonBase64)
    })

    it('invoice in header is a bolt11 string', async () => {
      const preimageMap = new Map<string, string>()
      const storage = mockStorage()
      const backend = mockBackend(preimageMap)

      const engine = createTollBooth({
        rootKey: ROOT_KEY,
        upstream: 'http://localhost:9999',
        pricing: { '/api/test': 100 },
        defaultInvoiceAmount: 100,
        storage,
        backend,
      })

      const result = expectChallenge(await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: {},
        ip: '10.0.0.1',
      }))

      const match = LNGET_CHALLENGE_RE.exec(result.headers['WWW-Authenticate']!)!
      const invoice = match[2]

      // lnget expects bolt11 format (starts with lnbc/lntb/lnbcrt)
      expect(invoice).toMatch(/^ln/)
    })
  })

  describe('full L402 flow (lnget perspective)', () => {
    it('challenge -> pay -> authorise -> proxy', async () => {
      const preimageMap = new Map<string, string>()
      const storage = mockStorage()
      const backend = mockBackend(preimageMap)

      const engine = createTollBooth({
        rootKey: ROOT_KEY,
        upstream: 'http://localhost:9999',
        pricing: { '/api/test': 100 },
        defaultInvoiceAmount: 100,
        storage,
        backend,
      })

      // Step 1: lnget sends unauthenticated request, gets 402
      const challenge = expectChallenge(await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: {},
        ip: '10.0.0.1',
      }))

      // Step 2: lnget parses the challenge using its regex
      const match = LNGET_CHALLENGE_RE.exec(challenge.headers['WWW-Authenticate']!)!
      const macaroonBase64 = match[1]

      // Step 3: lnget pays the invoice and obtains the preimage
      // (simulated; in reality lnget calls LND/LNC to pay)
      const body = challenge.body as { l402: { payment_hash: string } }
      const paymentHash = body.l402.payment_hash
      const preimage = preimageMap.get(paymentHash)!
      expect(preimage).toBeDefined()
      expect(preimage).toMatch(LNGET_PREIMAGE_RE)

      // Step 4: lnget constructs the Authorization header
      // lnget mirrors the server's prefix (L402)
      const authHeader = `L402 ${macaroonBase64}:${preimage}`

      // Step 5: lnget sends authenticated request
      const authed = await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: { authorization: authHeader },
        ip: '10.0.0.1',
      })

      expect(authed.action).toBe('proxy')
    })
  })

  describe('token reuse (lnget caches per domain)', () => {
    it('same token works for multiple requests while credits remain', async () => {
      const preimageMap = new Map<string, string>()
      const storage = mockStorage()
      const backend = mockBackend(preimageMap)
      const cost = 10

      const engine = createTollBooth({
        rootKey: ROOT_KEY,
        upstream: 'http://localhost:9999',
        pricing: { '/api/test': cost },
        defaultInvoiceAmount: 100, // 100 sats credited; each request costs 10
        storage,
        backend,
      })

      // Get initial 402 challenge
      const challenge = expectChallenge(await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: {},
        ip: '10.0.0.1',
      }))

      const match = LNGET_CHALLENGE_RE.exec(challenge.headers['WWW-Authenticate']!)!
      const macaroon = match[1]

      const body = challenge.body as { l402: { payment_hash: string } }
      const preimage = preimageMap.get(body.l402.payment_hash)!

      // lnget caches this token and reuses it
      const cachedAuth = `L402 ${macaroon}:${preimage}`

      // Should handle 10 requests (100 sats / 10 sats per request)
      for (let i = 0; i < 10; i++) {
        const result = await engine.handle({
          method: 'GET',
          path: '/api/test',
          headers: { authorization: cachedAuth },
          ip: '10.0.0.1',
        })
        expect(result.action).toBe('proxy')
      }

      // 11th request: credits exhausted, toll-booth returns 402 again
      // lnget would detect this and start a new payment cycle
      const exhausted = expectChallenge(await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: { authorization: cachedAuth },
        ip: '10.0.0.1',
      }))
      expect(exhausted.status).toBe(402)
    })

    it('X-Credit-Balance header returned on proxied responses', async () => {
      const preimageMap = new Map<string, string>()
      const storage = mockStorage()
      const backend = mockBackend(preimageMap)

      const engine = createTollBooth({
        rootKey: ROOT_KEY,
        upstream: 'http://localhost:9999',
        pricing: { '/api/test': 10 },
        defaultInvoiceAmount: 100,
        storage,
        backend,
      })

      const challenge = expectChallenge(await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: {},
        ip: '10.0.0.1',
      }))

      const match = LNGET_CHALLENGE_RE.exec(challenge.headers['WWW-Authenticate']!)!
      const body = challenge.body as { l402: { payment_hash: string } }
      const preimage = preimageMap.get(body.l402.payment_hash)!
      const auth = `L402 ${match[1]}:${preimage}`

      const result = await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: { authorization: auth },
        ip: '10.0.0.1',
      })

      // lnget doesn't use this header, but it shouldn't break anything
      expect(result.headers['X-Credit-Balance']).toBeDefined()
      expect(Number(result.headers['X-Credit-Balance'])).toBe(90) // 100 - 10
    })
  })

  describe('lnget edge cases', () => {
    it('lowercase authorization header accepted', async () => {
      const preimageMap = new Map<string, string>()
      const storage = mockStorage()
      const backend = mockBackend(preimageMap)

      const engine = createTollBooth({
        rootKey: ROOT_KEY,
        upstream: 'http://localhost:9999',
        pricing: { '/api/test': 10 },
        defaultInvoiceAmount: 100,
        storage,
        backend,
      })

      const challenge = expectChallenge(await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: {},
        ip: '10.0.0.1',
      }))

      const match = LNGET_CHALLENGE_RE.exec(challenge.headers['WWW-Authenticate']!)!
      const body = challenge.body as { l402: { payment_hash: string } }
      const preimage = preimageMap.get(body.l402.payment_hash)!

      // Go's http.Client sends 'Authorization' (capitalised), but
      // some proxies may lowercase it
      const result = await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: { authorization: `L402 ${match[1]}:${preimage}` },
        ip: '10.0.0.1',
      })

      expect(result.action).toBe('proxy')
    })

    it('macaroon base64 padding does not confuse colon split', async () => {
      // Base64 macaroons can contain '=' padding but no colons.
      // toll-booth splits on lastIndexOf(':') which handles this correctly.
      const preimageMap = new Map<string, string>()
      const storage = mockStorage()
      const backend = mockBackend(preimageMap)

      const engine = createTollBooth({
        rootKey: ROOT_KEY,
        upstream: 'http://localhost:9999',
        pricing: { '/api/test': 10 },
        defaultInvoiceAmount: 100,
        storage,
        backend,
      })

      const challenge = expectChallenge(await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: {},
        ip: '10.0.0.1',
      }))

      const match = LNGET_CHALLENGE_RE.exec(challenge.headers['WWW-Authenticate']!)!
      const macaroon = match[1]
      const body = challenge.body as { l402: { payment_hash: string } }
      const preimage = preimageMap.get(body.l402.payment_hash)!

      // Base64 might have padding
      expect(macaroon).toMatch(/^[A-Za-z0-9+/]+=*$/)

      const result = await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: { authorization: `L402 ${macaroon}:${preimage}` },
        ip: '10.0.0.1',
      })

      expect(result.action).toBe('proxy')
    })

    it('response body includes JSON that lnget can parse', async () => {
      const preimageMap = new Map<string, string>()
      const storage = mockStorage()
      const backend = mockBackend(preimageMap)

      const engine = createTollBooth({
        rootKey: ROOT_KEY,
        upstream: 'http://localhost:9999',
        pricing: { '/api/test': 100 },
        defaultInvoiceAmount: 100,
        storage,
        backend,
        serviceName: 'test-service',
      })

      const challenge = expectChallenge(await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: {},
        ip: '10.0.0.1',
      }))

      const body = challenge.body as Record<string, unknown>
      expect(body.message).toBe('Payment required.')

      const l402 = body.l402 as Record<string, unknown>
      expect(l402.invoice).toBeDefined()
      expect(l402.macaroon).toBeDefined()
      expect(l402.payment_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(l402.amount_sats).toBe(100)

      // Auth hint tells clients how to authenticate
      expect(body.auth_hint).toContain('L402')
    })

    it('lnget stale token eviction triggers fresh 402 cycle', async () => {
      // When lnget detects a server rejects its cached token, it evicts
      // and retries. Simulate: use a token minted with a different root key.
      const preimageMap = new Map<string, string>()
      const storage = mockStorage()
      const backend = mockBackend(preimageMap)

      const engine = createTollBooth({
        rootKey: ROOT_KEY,
        upstream: 'http://localhost:9999',
        pricing: { '/api/test': 10 },
        defaultInvoiceAmount: 100,
        storage,
        backend,
      })

      // Simulate a stale token from a different server
      const { preimage } = makePreimageAndHash()
      const staleAuth = `L402 ${Buffer.from('invalid-macaroon').toString('base64')}:${preimage}`

      // toll-booth should reject the stale token and return 402
      const result = expectChallenge(await engine.handle({
        method: 'GET',
        path: '/api/test',
        headers: { authorization: staleAuth },
        ip: '10.0.0.1',
      }))

      // lnget sees 402, evicts stale token, starts fresh payment cycle
      expect(result.status).toBe(402)
      expect(result.headers['WWW-Authenticate']).toBeDefined()
      expect(LNGET_CHALLENGE_RE.test(result.headers['WWW-Authenticate']!)).toBe(true)
    })
  })
})
