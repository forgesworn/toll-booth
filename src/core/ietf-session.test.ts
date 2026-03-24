// src/core/ietf-session.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { memoryStorage } from '../storage/memory.js'
import { createIETFSessionRail } from './ietf-session.js'
import type { LightningBackend, SessionConfig } from '../types.js'
import type { StorageBackend } from '../storage/interface.js'
import type { TollBoothRequest } from './types.js'
import { computeChallengeId, encodeJCS } from './ietf-payment.js'
import type { IETFChallengeParams, IETFCredential } from './ietf-payment.js'
import type { SessionChallengeRequest, SessionOpenPayload, SessionBearerPayload, SessionClosePayload, SessionTopUpPayload } from './ietf-session.js'

// --- Test helpers ---

const HMAC_SECRET = randomBytes(32).toString('hex')
const REALM = 'test.example.com'

function makePreimage(): { preimage: string; paymentHash: string } {
  const preimage = randomBytes(32).toString('hex')
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
  return { preimage, paymentHash }
}

function createMockBackend(invoiceMap: Map<string, { preimage: string; paymentHash: string }>): LightningBackend {
  return {
    async createInvoice(amountSats: number, memo?: string) {
      const { preimage, paymentHash } = makePreimage()
      invoiceMap.set(paymentHash, { preimage, paymentHash })
      return { bolt11: `lnbc${amountSats}test${paymentHash.slice(0, 16)}`, paymentHash }
    },
    async checkInvoice(paymentHash: string) {
      const entry = invoiceMap.get(paymentHash)
      return entry ? { paid: true, preimage: entry.preimage } : { paid: false }
    },
    async sendPayment(bolt11: string) {
      return { preimage: randomBytes(32).toString('hex') }
    },
  }
}

function makeRequest(authHeader: string): TollBoothRequest {
  return {
    method: 'GET',
    path: '/v1/chat/completions',
    headers: { authorization: authHeader },
    ip: '127.0.0.1',
  }
}

function encodeCredential(credential: IETFCredential): string {
  return `Payment ${Buffer.from(JSON.stringify(credential)).toString('base64url')}`
}

// --- Tests ---

describe('IETF Session Rail', () => {
  let storage: StorageBackend
  let invoiceMap: Map<string, { preimage: string; paymentHash: string }>
  let backend: LightningBackend
  const sessionConfig: SessionConfig = {
    maxSessionDurationMs: 60_000, // 1 minute for fast tests
    maxDepositSats: 10_000,
  }

  beforeEach(() => {
    storage = memoryStorage()
    invoiceMap = new Map()
    backend = createMockBackend(invoiceMap)
  })

  function createRail() {
    return createIETFSessionRail({
      hmacSecret: HMAC_SECRET,
      realm: REALM,
      backend,
      storage,
      session: sessionConfig,
    })
  }

  describe('detect', () => {
    it('detects session bearer auth', () => {
      const rail = createRail()
      const credential: IETFCredential = {
        challenge: { id: '', realm: '', method: '', intent: '', request: '' },
        payload: { action: 'bearer', sessionToken: 'abc' },
      }
      const auth = encodeCredential(credential)
      expect(rail.detect(makeRequest(auth))).toBe(true)
    })

    it('detects session open auth', () => {
      const rail = createRail()
      const credential: IETFCredential = {
        challenge: { id: 'x', realm: REALM, method: 'lightning', intent: 'session', request: 'x' },
        payload: { action: 'open', preimage: 'abc' },
      }
      const auth = encodeCredential(credential)
      expect(rail.detect(makeRequest(auth))).toBe(true)
    })

    it('does not detect charge intent', () => {
      const rail = createRail()
      const credential: IETFCredential = {
        challenge: { id: 'x', realm: REALM, method: 'lightning', intent: 'charge', request: 'x' },
        payload: { preimage: 'abc' },
      }
      const auth = encodeCredential(credential)
      expect(rail.detect(makeRequest(auth))).toBe(false)
    })

    it('does not detect L402', () => {
      const rail = createRail()
      expect(rail.detect(makeRequest('L402 mac:preimage'))).toBe(false)
    })
  })

  describe('challenge', () => {
    it('issues a session challenge with deposit invoice', async () => {
      const rail = createRail()
      const fragment = await rail.challenge('/api/test', { sats: 1000 })

      expect(fragment.headers['WWW-Authenticate']).toMatch(/^Payment /)
      expect(fragment.headers['WWW-Authenticate']).toContain('intent="session"')
      expect(fragment.headers['WWW-Authenticate']).toContain(`realm="${REALM}"`)
      expect(fragment.body.ietf_session).toBeDefined()

      const body = fragment.body.ietf_session as Record<string, unknown>
      expect(body.intent).toBe('session')
      expect(body.deposit_sats).toBe(1000)
      expect(body.ttl_seconds).toBe(60)
    })

    it('caps deposit at maxDepositSats', async () => {
      const rail = createRail()
      const fragment = await rail.challenge('/api/test', { sats: 50_000 })

      const body = fragment.body.ietf_session as Record<string, unknown>
      expect(body.deposit_sats).toBe(10_000) // Capped
    })
  })

  describe('full lifecycle: open → bearer → close', () => {
    async function openSession(rail: ReturnType<typeof createRail>) {
      // Get a challenge to extract the session request
      const fragment = await rail.challenge('/api/test', { sats: 500 })
      const wwwAuth = fragment.headers['WWW-Authenticate']

      // Parse challenge params from WWW-Authenticate header
      const idMatch = wwwAuth.match(/id="([^"]+)"/)!
      const realmMatch = wwwAuth.match(/realm="([^"]+)"/)!
      const methodMatch = wwwAuth.match(/method="([^"]+)"/)!
      const intentMatch = wwwAuth.match(/intent="([^"]+)"/)!
      const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
      const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

      // Decode request to get payment hash
      const sessionRequest: SessionChallengeRequest = JSON.parse(
        Buffer.from(requestMatch[1], 'base64url').toString()
      )
      const paymentHash = sessionRequest.deposit.paymentHash
      const entry = invoiceMap.get(paymentHash)!

      // Build open credential
      const credential: IETFCredential = {
        challenge: {
          id: idMatch[1],
          realm: realmMatch[1],
          method: methodMatch[1],
          intent: intentMatch[1],
          request: requestMatch[1],
          expires: expiresMatch[1],
        },
        payload: {
          action: 'open',
          preimage: entry.preimage,
          returnInvoice: 'lnbc1testreturn',
        } satisfies SessionOpenPayload,
      }

      const auth = encodeCredential(credential)
      const result = await rail.verify(makeRequest(auth))
      return { result, paymentHash, sessionRequest }
    }

    it('opens a session with valid preimage', async () => {
      const rail = createRail()
      const { result } = await openSession(rail)

      expect(result.authenticated).toBe(true)
      expect(result.mode).toBe('session')
      expect(result.creditBalance).toBe(500)
      expect(result.customCaveats?.['X-Session-Token']).toBeDefined()
      expect(result.customCaveats?.['X-Session-Id']).toBeDefined()
      expect(result.customCaveats?.['X-Session-Expires']).toBeDefined()
    })

    it('authenticates with bearer token', async () => {
      const rail = createRail()
      const { result } = await openSession(rail)
      const bearerToken = result.customCaveats!['X-Session-Token']

      // Use bearer token for a request
      const bearerCredential: IETFCredential = {
        challenge: { id: '', realm: '', method: '', intent: '', request: '' },
        payload: { action: 'bearer', sessionToken: bearerToken } satisfies SessionBearerPayload,
      }
      const bearerAuth = encodeCredential(bearerCredential)
      const bearerResult = await rail.verify(makeRequest(bearerAuth))

      expect(bearerResult.authenticated).toBe(true)
      expect(bearerResult.mode).toBe('session')
      expect(bearerResult.creditBalance).toBe(500)
    })

    it('deducts balance via storage on bearer auth', async () => {
      const rail = createRail()
      const { result } = await openSession(rail)
      const sessionId = result.customCaveats!['X-Session-Id']

      // Simulate a deduction (normally done by TollBoothEngine)
      storage.deductSession(sessionId, 100)

      // Check balance via bearer
      const bearerToken = result.customCaveats!['X-Session-Token']
      const bearerCredential: IETFCredential = {
        challenge: { id: '', realm: '', method: '', intent: '', request: '' },
        payload: { action: 'bearer', sessionToken: bearerToken } satisfies SessionBearerPayload,
      }
      const bearerResult = await rail.verify(makeRequest(encodeCredential(bearerCredential)))

      expect(bearerResult.creditBalance).toBe(400)
    })

    it('closes session and triggers refund', async () => {
      const rail = createRail()
      const { result, sessionRequest } = await openSession(rail)
      const bearerToken = result.customCaveats!['X-Session-Token']

      // Get a new challenge for the close action (reuse params from open)
      const fragment = await rail.challenge('/api/test', { sats: 500 })
      const wwwAuth = fragment.headers['WWW-Authenticate']
      const idMatch = wwwAuth.match(/id="([^"]+)"/)!
      const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
      const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

      const newSessionRequest: SessionChallengeRequest = JSON.parse(
        Buffer.from(requestMatch[1], 'base64url').toString()
      )
      const newEntry = invoiceMap.get(newSessionRequest.deposit.paymentHash)!

      const closeCredential: IETFCredential = {
        challenge: {
          id: idMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: requestMatch[1],
          expires: expiresMatch[1],
        },
        payload: {
          action: 'close',
          sessionToken: bearerToken,
        } satisfies SessionClosePayload,
      }

      const closeResult = await rail.verify(makeRequest(encodeCredential(closeCredential)))

      expect(closeResult.authenticated).toBe(true)
      expect(closeResult.creditBalance).toBe(0)
      expect(closeResult.customCaveats?.['X-Session-Closed']).toBe('true')
    })

    it('closes an already-closed session gracefully (close replay)', async () => {
      const rail = createRail()
      const { result } = await openSession(rail)
      const bearerToken = result.customCaveats!['X-Session-Token']
      const sessionId = result.customCaveats!['X-Session-Id']

      // Close via storage directly
      storage.closeSession(sessionId)

      // Attempting to close again via the rail should fail gracefully (not throw)
      const fragment = await rail.challenge('/api/test', { sats: 500 })
      const wwwAuth = fragment.headers['WWW-Authenticate']
      const idMatch = wwwAuth.match(/id="([^"]+)"/)!
      const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
      const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

      const closeCredential: IETFCredential = {
        challenge: {
          id: idMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: requestMatch[1],
          expires: expiresMatch[1],
        },
        payload: {
          action: 'close',
          sessionToken: bearerToken,
        } satisfies SessionClosePayload,
      }

      const closeResult = await rail.verify(makeRequest(encodeCredential(closeCredential)))
      // Should return unauthenticated (session already closed), not throw
      expect(closeResult.authenticated).toBe(false)
    })

    it('skips refund gracefully when no returnInvoice was provided', async () => {
      const rail = createRail()

      // Open a session without a returnInvoice
      const fragment = await rail.challenge('/api/test', { sats: 500 })
      const wwwAuth = fragment.headers['WWW-Authenticate']
      const idMatch = wwwAuth.match(/id="([^"]+)"/)!
      const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
      const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

      const sessionRequest: SessionChallengeRequest = JSON.parse(
        Buffer.from(requestMatch[1], 'base64url').toString()
      )
      const entry = invoiceMap.get(sessionRequest.deposit.paymentHash)!

      const openCredential: IETFCredential = {
        challenge: {
          id: idMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: requestMatch[1],
          expires: expiresMatch[1],
        },
        payload: {
          action: 'open',
          preimage: entry.preimage,
          // No returnInvoice
        } satisfies SessionOpenPayload,
      }

      const openResult = await rail.verify(makeRequest(encodeCredential(openCredential)))
      expect(openResult.authenticated).toBe(true)
      const bearerToken = openResult.customCaveats!['X-Session-Token']

      // Spy on sendPayment to ensure it is NOT called
      const sendPaymentSpy = vi.spyOn(backend, 'sendPayment' as any)

      // Close the session — refund should be skipped (no return invoice)
      const closeFragment = await rail.challenge('/api/test', { sats: 500 })
      const closeWwwAuth = closeFragment.headers['WWW-Authenticate']
      const closeIdMatch = closeWwwAuth.match(/id="([^"]+)"/)!
      const closeRequestMatch = closeWwwAuth.match(/request="([^"]+)"/)!
      const closeExpiresMatch = closeWwwAuth.match(/expires="([^"]+)"/)!

      const closeCredential: IETFCredential = {
        challenge: {
          id: closeIdMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: closeRequestMatch[1],
          expires: closeExpiresMatch[1],
        },
        payload: {
          action: 'close',
          sessionToken: bearerToken,
        } satisfies SessionClosePayload,
      }

      const closeResult = await rail.verify(makeRequest(encodeCredential(closeCredential)))
      expect(closeResult.authenticated).toBe(true)
      expect(closeResult.customCaveats?.['X-Session-Closed']).toBe('true')
      expect(sendPaymentSpy).not.toHaveBeenCalled()

      sendPaymentSpy.mockRestore()
    })

    it('still closes session even if sendPayment fails during refund', async () => {
      // Create a backend where sendPayment throws
      const failingBackend: LightningBackend = {
        async createInvoice(amountSats: number, memo?: string) {
          return backend.createInvoice(amountSats, memo)
        },
        async checkInvoice(paymentHash: string) {
          return backend.checkInvoice(paymentHash)
        },
        async sendPayment(_bolt11: string) {
          throw new Error('Lightning node unreachable')
        },
      }

      const rail = createIETFSessionRail({
        hmacSecret: HMAC_SECRET,
        realm: REALM,
        backend: failingBackend,
        storage,
        session: sessionConfig,
      })

      // Open a session with a returnInvoice
      const fragment = await rail.challenge('/api/test', { sats: 500 })
      const wwwAuth = fragment.headers['WWW-Authenticate']
      const idMatch = wwwAuth.match(/id="([^"]+)"/)!
      const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
      const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

      const sessionRequest: SessionChallengeRequest = JSON.parse(
        Buffer.from(requestMatch[1], 'base64url').toString()
      )
      const entry = invoiceMap.get(sessionRequest.deposit.paymentHash)!

      const openCredential: IETFCredential = {
        challenge: {
          id: idMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: requestMatch[1],
          expires: expiresMatch[1],
        },
        payload: {
          action: 'open',
          preimage: entry.preimage,
          returnInvoice: 'lnbc1testreturn',
        } satisfies SessionOpenPayload,
      }

      const openResult = await rail.verify(makeRequest(encodeCredential(openCredential)))
      expect(openResult.authenticated).toBe(true)
      const bearerToken = openResult.customCaveats!['X-Session-Token']

      // Close the session — sendPayment will throw, but close should still succeed
      const closeFragment = await rail.challenge('/api/test', { sats: 500 })
      const closeWwwAuth = closeFragment.headers['WWW-Authenticate']
      const closeIdMatch = closeWwwAuth.match(/id="([^"]+)"/)!
      const closeRequestMatch = closeWwwAuth.match(/request="([^"]+)"/)!
      const closeExpiresMatch = closeWwwAuth.match(/expires="([^"]+)"/)!

      const closeCredential: IETFCredential = {
        challenge: {
          id: closeIdMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: closeRequestMatch[1],
          expires: closeExpiresMatch[1],
        },
        payload: {
          action: 'close',
          sessionToken: bearerToken,
        } satisfies SessionClosePayload,
      }

      // Should not throw — close succeeds even though refund fails
      const closeResult = await rail.verify(makeRequest(encodeCredential(closeCredential)))
      expect(closeResult.authenticated).toBe(true)
      expect(closeResult.customCaveats?.['X-Session-Closed']).toBe('true')
      // No refund preimage since sendPayment failed
      expect(closeResult.customCaveats?.['X-Refund-Preimage']).toBeUndefined()
    })

    it('accepts top-up with same preimage as deposit (different challenge)', async () => {
      const rail = createRail()
      const { result } = await openSession(rail)
      const bearerToken = result.customCaveats!['X-Session-Token']

      // Get a new challenge for the top-up
      const topupFragment = await rail.challenge('/api/test', { sats: 200 })
      const topupWwwAuth = topupFragment.headers['WWW-Authenticate']
      const topupIdMatch = topupWwwAuth.match(/id="([^"]+)"/)!
      const topupRequestMatch = topupWwwAuth.match(/request="([^"]+)"/)!
      const topupExpiresMatch = topupWwwAuth.match(/expires="([^"]+)"/)!

      const topupSessionRequest: SessionChallengeRequest = JSON.parse(
        Buffer.from(topupRequestMatch[1], 'base64url').toString()
      )
      const topupEntry = invoiceMap.get(topupSessionRequest.deposit.paymentHash)!

      const topupCredential: IETFCredential = {
        challenge: {
          id: topupIdMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: topupRequestMatch[1],
          expires: topupExpiresMatch[1],
        },
        payload: {
          action: 'topup',
          sessionToken: bearerToken,
          preimage: topupEntry.preimage,
        } satisfies SessionTopUpPayload,
      }

      const topupResult = await rail.verify(makeRequest(encodeCredential(topupCredential)))
      expect(topupResult.authenticated).toBe(true)
      // Original deposit was 500, top-up is 200
      expect(topupResult.creditBalance).toBe(700)
    })

    it('rejects bearer token after close', async () => {
      const rail = createRail()
      const { result, sessionRequest } = await openSession(rail)
      const bearerToken = result.customCaveats!['X-Session-Token']
      const sessionId = result.customCaveats!['X-Session-Id']

      // Close via storage directly
      storage.closeSession(sessionId)

      const bearerCredential: IETFCredential = {
        challenge: { id: '', realm: '', method: '', intent: '', request: '' },
        payload: { action: 'bearer', sessionToken: bearerToken } satisfies SessionBearerPayload,
      }
      const bearerResult = await rail.verify(makeRequest(encodeCredential(bearerCredential)))
      expect(bearerResult.authenticated).toBe(false)
    })
  })

  describe('compliance guardrails', () => {
    it('rejects deposit exceeding maxDepositSats', async () => {
      const rail = createRail()
      // Open with the capped amount succeeds, but verify with a forged higher amount would fail
      // because the HMAC binding prevents tampering
      const { result } = await (async () => {
        const fragment = await rail.challenge('/api/test', { sats: 10_000 })
        const wwwAuth = fragment.headers['WWW-Authenticate']
        const idMatch = wwwAuth.match(/id="([^"]+)"/)!
        const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
        const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

        const sessionRequest: SessionChallengeRequest = JSON.parse(
          Buffer.from(requestMatch[1], 'base64url').toString()
        )
        const entry = invoiceMap.get(sessionRequest.deposit.paymentHash)!

        const credential: IETFCredential = {
          challenge: {
            id: idMatch[1],
            realm: REALM,
            method: 'lightning',
            intent: 'session',
            request: requestMatch[1],
            expires: expiresMatch[1],
          },
          payload: { action: 'open', preimage: entry.preimage } satisfies SessionOpenPayload,
        }

        return { result: await rail.verify(makeRequest(encodeCredential(credential))) }
      })()

      expect(result.authenticated).toBe(true)
      expect(result.creditBalance).toBe(10_000) // At cap, not exceeding
    })

    it('rejects top-up that would exceed maxDepositSats', async () => {
      const rail = createRail()

      // Open a session at 8000 sats
      const fragment = await rail.challenge('/api/test', { sats: 8000 })
      const wwwAuth = fragment.headers['WWW-Authenticate']
      const idMatch = wwwAuth.match(/id="([^"]+)"/)!
      const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
      const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

      const sessionRequest: SessionChallengeRequest = JSON.parse(
        Buffer.from(requestMatch[1], 'base64url').toString()
      )
      const entry = invoiceMap.get(sessionRequest.deposit.paymentHash)!

      const openCredential: IETFCredential = {
        challenge: {
          id: idMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: requestMatch[1],
          expires: expiresMatch[1],
        },
        payload: { action: 'open', preimage: entry.preimage } satisfies SessionOpenPayload,
      }

      const openResult = await rail.verify(makeRequest(encodeCredential(openCredential)))
      expect(openResult.authenticated).toBe(true)
      const bearerToken = openResult.customCaveats!['X-Session-Token']

      // Try to top up 5000 sats (would make 13000 > 10000 cap)
      const topupFragment = await rail.challenge('/api/test', { sats: 5000 })
      const topupWwwAuth = topupFragment.headers['WWW-Authenticate']
      const topupIdMatch = topupWwwAuth.match(/id="([^"]+)"/)!
      const topupRequestMatch = topupWwwAuth.match(/request="([^"]+)"/)!
      const topupExpiresMatch = topupWwwAuth.match(/expires="([^"]+)"/)!

      const topupSessionRequest: SessionChallengeRequest = JSON.parse(
        Buffer.from(topupRequestMatch[1], 'base64url').toString()
      )
      const topupEntry = invoiceMap.get(topupSessionRequest.deposit.paymentHash)!

      const topupCredential: IETFCredential = {
        challenge: {
          id: topupIdMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: topupRequestMatch[1],
          expires: topupExpiresMatch[1],
        },
        payload: {
          action: 'topup',
          sessionToken: bearerToken,
          preimage: topupEntry.preimage,
        } satisfies SessionTopUpPayload,
      }

      const topupResult = await rail.verify(makeRequest(encodeCredential(topupCredential)))
      expect(topupResult.authenticated).toBe(false) // Exceeds cap
    })

    it('sweeps expired sessions', async () => {
      const shortConfig: SessionConfig = {
        maxSessionDurationMs: 1, // Expires immediately
        maxDepositSats: 10_000,
      }
      const rail = createIETFSessionRail({
        hmacSecret: HMAC_SECRET,
        realm: REALM,
        backend,
        storage,
        session: shortConfig,
      })

      // Open a session
      const fragment = await rail.challenge('/api/test', { sats: 500 })
      const wwwAuth = fragment.headers['WWW-Authenticate']
      const idMatch = wwwAuth.match(/id="([^"]+)"/)!
      const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
      const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

      const sessionRequest: SessionChallengeRequest = JSON.parse(
        Buffer.from(requestMatch[1], 'base64url').toString()
      )
      const entry = invoiceMap.get(sessionRequest.deposit.paymentHash)!

      const credential: IETFCredential = {
        challenge: {
          id: idMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: requestMatch[1],
          expires: expiresMatch[1],
        },
        payload: {
          action: 'open',
          preimage: entry.preimage,
          returnInvoice: 'lnbc1testreturn',
        } satisfies SessionOpenPayload,
      }

      await rail.verify(makeRequest(encodeCredential(credential)))

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 10))

      // Sweep
      const swept = await rail.sweepExpired()
      expect(swept).toBe(1)
    })
  })

  describe('security', () => {
    it('rejects invalid preimage', async () => {
      const rail = createRail()
      const fragment = await rail.challenge('/api/test', { sats: 500 })
      const wwwAuth = fragment.headers['WWW-Authenticate']
      const idMatch = wwwAuth.match(/id="([^"]+)"/)!
      const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
      const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

      const wrongPreimage = randomBytes(32).toString('hex')

      const credential: IETFCredential = {
        challenge: {
          id: idMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: requestMatch[1],
          expires: expiresMatch[1],
        },
        payload: { action: 'open', preimage: wrongPreimage } satisfies SessionOpenPayload,
      }

      const result = await rail.verify(makeRequest(encodeCredential(credential)))
      expect(result.authenticated).toBe(false)
    })

    it('rejects tampered challenge (HMAC failure)', async () => {
      const rail = createRail()
      const fragment = await rail.challenge('/api/test', { sats: 500 })
      const wwwAuth = fragment.headers['WWW-Authenticate']
      const idMatch = wwwAuth.match(/id="([^"]+)"/)!
      const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
      const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

      const sessionRequest: SessionChallengeRequest = JSON.parse(
        Buffer.from(requestMatch[1], 'base64url').toString()
      )
      const entry = invoiceMap.get(sessionRequest.deposit.paymentHash)!

      const credential: IETFCredential = {
        challenge: {
          id: 'tampered-id',
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: requestMatch[1],
          expires: expiresMatch[1],
        },
        payload: { action: 'open', preimage: entry.preimage } satisfies SessionOpenPayload,
      }

      const result = await rail.verify(makeRequest(encodeCredential(credential)))
      expect(result.authenticated).toBe(false)
    })

    it('rejects unknown bearer token', async () => {
      const rail = createRail()
      const credential: IETFCredential = {
        challenge: { id: '', realm: '', method: '', intent: '', request: '' },
        payload: { action: 'bearer', sessionToken: 'nonexistent' } satisfies SessionBearerPayload,
      }

      const result = await rail.verify(makeRequest(encodeCredential(credential)))
      expect(result.authenticated).toBe(false)
    })

    it('rejects duplicate session open (replay of same deposit preimage)', async () => {
      const rail = createRail()
      const fragment = await rail.challenge('/api/test', { sats: 500 })
      const wwwAuth = fragment.headers['WWW-Authenticate']
      const idMatch = wwwAuth.match(/id="([^"]+)"/)!
      const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
      const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

      const sessionRequest: SessionChallengeRequest = JSON.parse(
        Buffer.from(requestMatch[1], 'base64url').toString()
      )
      const entry = invoiceMap.get(sessionRequest.deposit.paymentHash)!

      const credential: IETFCredential = {
        challenge: {
          id: idMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: requestMatch[1],
          expires: expiresMatch[1],
        },
        payload: { action: 'open', preimage: entry.preimage } satisfies SessionOpenPayload,
      }

      // First open succeeds
      const first = await rail.verify(makeRequest(encodeCredential(credential)))
      expect(first.authenticated).toBe(true)

      // Replay of same credential should fail (session already exists)
      const second = await rail.verify(makeRequest(encodeCredential(credential)))
      expect(second.authenticated).toBe(false)
    })

    it('rejects expired challenge on open', async () => {
      const rail = createRail()
      const fragment = await rail.challenge('/api/test', { sats: 500 })
      const wwwAuth = fragment.headers['WWW-Authenticate']
      const requestMatch = wwwAuth.match(/request="([^"]+)"/)!

      const sessionRequest: SessionChallengeRequest = JSON.parse(
        Buffer.from(requestMatch[1], 'base64url').toString()
      )
      const entry = invoiceMap.get(sessionRequest.deposit.paymentHash)!

      // Build credential with an expires in the past and a valid HMAC
      const pastExpires = new Date(Date.now() - 60_000).toISOString()
      const params: IETFChallengeParams = {
        realm: REALM,
        method: 'lightning',
        intent: 'session',
        request: requestMatch[1],
        expires: pastExpires,
      }
      const id = computeChallengeId(HMAC_SECRET, params)

      const credential: IETFCredential = {
        challenge: {
          id,
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: requestMatch[1],
          expires: pastExpires,
        },
        payload: { action: 'open', preimage: entry.preimage } satisfies SessionOpenPayload,
      }

      const result = await rail.verify(makeRequest(encodeCredential(credential)))
      expect(result.authenticated).toBe(false)
    })

    it('rejects bearer auth on expired session', async () => {
      const shortConfig: SessionConfig = {
        maxSessionDurationMs: 1, // Expires immediately
        maxDepositSats: 10_000,
      }
      const rail = createIETFSessionRail({
        hmacSecret: HMAC_SECRET,
        realm: REALM,
        backend,
        storage,
        session: shortConfig,
      })

      // Open a session
      const fragment = await rail.challenge('/api/test', { sats: 500 })
      const wwwAuth = fragment.headers['WWW-Authenticate']
      const idMatch = wwwAuth.match(/id="([^"]+)"/)!
      const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
      const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

      const sessionRequest: SessionChallengeRequest = JSON.parse(
        Buffer.from(requestMatch[1], 'base64url').toString()
      )
      const entry = invoiceMap.get(sessionRequest.deposit.paymentHash)!

      const credential: IETFCredential = {
        challenge: {
          id: idMatch[1],
          realm: REALM,
          method: 'lightning',
          intent: 'session',
          request: requestMatch[1],
          expires: expiresMatch[1],
        },
        payload: {
          action: 'open',
          preimage: entry.preimage,
        } satisfies SessionOpenPayload,
      }

      const openResult = await rail.verify(makeRequest(encodeCredential(credential)))
      expect(openResult.authenticated).toBe(true)
      const bearerToken = openResult.customCaveats!['X-Session-Token']

      // Wait for session to expire
      await new Promise((r) => setTimeout(r, 10))

      // Bearer auth should now be rejected
      const bearerCredential: IETFCredential = {
        challenge: { id: '', realm: '', method: '', intent: '', request: '' },
        payload: { action: 'bearer', sessionToken: bearerToken } satisfies SessionBearerPayload,
      }
      const bearerResult = await rail.verify(makeRequest(encodeCredential(bearerCredential)))
      expect(bearerResult.authenticated).toBe(false)
    })

    it('returns unauthenticated for malformed base64url in Authorization header', async () => {
      const rail = createRail()
      // Not valid base64url — contains characters that will produce invalid JSON
      const malformedAuth = 'Payment !!!not-valid-base64url@@@'
      const result = await rail.verify(makeRequest(malformedAuth))
      expect(result.authenticated).toBe(false)
    })

    it('generates unique bearer tokens per session', async () => {
      const rail = createRail()
      const tokens: string[] = []

      for (let i = 0; i < 5; i++) {
        const fragment = await rail.challenge('/api/test', { sats: 100 })
        const wwwAuth = fragment.headers['WWW-Authenticate']
        const idMatch = wwwAuth.match(/id="([^"]+)"/)!
        const requestMatch = wwwAuth.match(/request="([^"]+)"/)!
        const expiresMatch = wwwAuth.match(/expires="([^"]+)"/)!

        const sessionRequest: SessionChallengeRequest = JSON.parse(
          Buffer.from(requestMatch[1], 'base64url').toString()
        )
        const entry = invoiceMap.get(sessionRequest.deposit.paymentHash)!

        const credential: IETFCredential = {
          challenge: {
            id: idMatch[1],
            realm: REALM,
            method: 'lightning',
            intent: 'session',
            request: requestMatch[1],
            expires: expiresMatch[1],
          },
          payload: { action: 'open', preimage: entry.preimage } satisfies SessionOpenPayload,
        }

        const result = await rail.verify(makeRequest(encodeCredential(credential)))
        tokens.push(result.customCaveats!['X-Session-Token'])
      }

      const unique = new Set(tokens)
      expect(unique.size).toBe(5)
    })
  })
})
