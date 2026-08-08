import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { computeChallengeId, verifyChallengeId, encodeJCS, createIETFPaymentRail, buildReceiptHeader } from './ietf-payment.js'
import type { IETFChallengeParams } from './ietf-payment.js'
import { memoryStorage } from '../storage/memory.js'
import type { LightningBackend } from '../types.js'

// --- Test helpers ---

/** Create a mock backend with a known preimage/paymentHash pair. */
function knownHashBackend(): { backend: LightningBackend; preimage: string; paymentHash: string } {
  const preimage = Buffer.alloc(32, 0xcd)
  const paymentHash = createHash('sha256').update(preimage).digest('hex')
  return {
    preimage: preimage.toString('hex'),
    paymentHash,
    backend: {
      async createInvoice(amountSats: number) {
        return { bolt11: `lnbc${amountSats}n1mock`, paymentHash }
      },
      async checkInvoice() {
        return { paid: true, preimage: preimage.toString('hex') }
      },
    },
  }
}

/** Parse WWW-Authenticate: Payment header into param map. */
function parseWWWAuth(header: string): Record<string, string> {
  const params: Record<string, string> = {}
  for (const match of header.matchAll(/(\w+)="([^"]+)"/g)) {
    params[match[1]] = match[2]
  }
  return params
}

/** Build a base64url credential from a challenge header and preimage. */
function buildCredential(header: string, preimage: string): string {
  const params = parseWWWAuth(header)
  const credential = {
    challenge: {
      id: params.id,
      realm: params.realm,
      method: params.method,
      intent: params.intent,
      request: params.request,
      expires: params.expires,
    },
    payload: { preimage },
  }
  return Buffer.from(JSON.stringify(credential)).toString('base64url')
}

describe('HMAC challenge binding', () => {
  const secret = 'a'.repeat(64)

  const baseParams: IETFChallengeParams = {
    realm: 'api.example.com',
    method: 'lightning',
    intent: 'charge',
    request: 'eyJhbW91bnQiOiIxMDAwIn0',
  }

  it('produces a base64url challenge ID', () => {
    const id = computeChallengeId(secret, baseParams)
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(id.length).toBeGreaterThan(20)
  })

  it('is deterministic for the same inputs', () => {
    const id1 = computeChallengeId(secret, baseParams)
    const id2 = computeChallengeId(secret, baseParams)
    expect(id1).toBe(id2)
  })

  it('changes when realm changes', () => {
    const id1 = computeChallengeId(secret, baseParams)
    const id2 = computeChallengeId(secret, { ...baseParams, realm: 'other.com' })
    expect(id1).not.toBe(id2)
  })

  it('changes when method changes', () => {
    const id1 = computeChallengeId(secret, baseParams)
    const id2 = computeChallengeId(secret, { ...baseParams, method: 'cashu' })
    expect(id1).not.toBe(id2)
  })

  it('changes when intent changes', () => {
    const id1 = computeChallengeId(secret, baseParams)
    const id2 = computeChallengeId(secret, { ...baseParams, intent: 'session' })
    expect(id1).not.toBe(id2)
  })

  it('changes when request changes', () => {
    const id1 = computeChallengeId(secret, baseParams)
    const id2 = computeChallengeId(secret, { ...baseParams, request: 'different' })
    expect(id1).not.toBe(id2)
  })

  it('changes when optional expires is added', () => {
    const id1 = computeChallengeId(secret, baseParams)
    const id2 = computeChallengeId(secret, { ...baseParams, expires: '2026-03-23T12:00:00Z' })
    expect(id1).not.toBe(id2)
  })

  it('changes when optional digest is added', () => {
    const id1 = computeChallengeId(secret, baseParams)
    const id2 = computeChallengeId(secret, { ...baseParams, digest: 'sha-256=abc' })
    expect(id1).not.toBe(id2)
  })

  it('changes when optional opaque is added', () => {
    const id1 = computeChallengeId(secret, baseParams)
    const id2 = computeChallengeId(secret, { ...baseParams, opaque: 'eyJmb28iOiJiYXIifQ' })
    expect(id1).not.toBe(id2)
  })

  it('produces different IDs for different secrets', () => {
    const id1 = computeChallengeId(secret, baseParams)
    const id2 = computeChallengeId('b'.repeat(64), baseParams)
    expect(id1).not.toBe(id2)
  })

  it('verifyChallengeId returns true for valid ID', () => {
    const id = computeChallengeId(secret, baseParams)
    expect(verifyChallengeId(secret, id, baseParams)).toBe(true)
  })

  it('verifyChallengeId returns false for tampered ID', () => {
    expect(verifyChallengeId(secret, 'tampered-id-value', baseParams)).toBe(false)
  })

  it('verifyChallengeId returns false for tampered params', () => {
    const id = computeChallengeId(secret, baseParams)
    expect(verifyChallengeId(secret, id, { ...baseParams, realm: 'evil.com' })).toBe(false)
  })

  it('verifyChallengeId returns false for wrong secret', () => {
    const id = computeChallengeId(secret, baseParams)
    expect(verifyChallengeId('b'.repeat(64), id, baseParams)).toBe(false)
  })
})

// --- Challenge flow tests ---

describe('IETF Payment rail — challenge', () => {
  const hmacSecret = 'a'.repeat(64)

  it('generates WWW-Authenticate: Payment header', async () => {
    const { backend } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
    })

    const fragment = await rail.challenge('/api/route', { sats: 100 })
    const header = fragment.headers['WWW-Authenticate']

    expect(header).toMatch(/^Payment /)
    expect(header).toContain('id="')
    expect(header).toContain('realm="api.example.com"')
    expect(header).toContain('method="lightning"')
    expect(header).toContain('intent="charge"')
    expect(header).toContain('request="')
    expect(header).toContain('expires="')
  })

  it('embeds BOLT11 invoice in the request parameter', async () => {
    const { backend, paymentHash } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
    })

    const fragment = await rail.challenge('/api/route', { sats: 100 })
    const params = parseWWWAuth(fragment.headers['WWW-Authenticate'])

    const decoded = JSON.parse(Buffer.from(params.request, 'base64url').toString())
    expect(decoded.amount).toBe('100')
    expect(decoded.currency).toBe('sat')
    expect(decoded.methodDetails.invoice).toMatch(/^lnbc/)
    expect(decoded.methodDetails.paymentHash).toBe(paymentHash)
  })

  it('includes ietf_payment in challenge body', async () => {
    const { backend, paymentHash } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
    })

    const fragment = await rail.challenge('/api/route', { sats: 100 })
    const body = fragment.body.ietf_payment as Record<string, unknown>
    expect(body.method).toBe('lightning')
    expect(body.intent).toBe('charge')
    expect(body.payment_hash).toBe(paymentHash)
    expect(body.amount_sats).toBe(100)
  })

  it('canChallenge returns true for sats, false for usd-only', () => {
    const { backend } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
    })
    expect(rail.canChallenge!({ sats: 100 })).toBe(true)
    expect(rail.canChallenge!({ usd: 10 })).toBe(false)
  })

  it('includes description when configured', async () => {
    const { backend } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
      description: 'Valhalla routing API',
    })

    const fragment = await rail.challenge('/api/route', { sats: 100 })
    expect(fragment.headers['WWW-Authenticate']).toContain('description="Valhalla routing API"')
  })

  it('detect returns true for Payment scheme, false for others', () => {
    const { backend } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'test.com',
      backend,
      storage: memoryStorage(),
    })

    expect(rail.detect({ method: 'GET', path: '/', headers: { authorization: 'Payment abc' }, ip: '127.0.0.1' })).toBe(true)
    expect(rail.detect({ method: 'GET', path: '/', headers: { authorization: 'L402 abc:def' }, ip: '127.0.0.1' })).toBe(false)
    expect(rail.detect({ method: 'GET', path: '/', headers: {}, ip: '127.0.0.1' })).toBe(false)
  })
})

// --- Verify flow tests ---

describe('IETF Payment rail — verify', () => {
  const hmacSecret = 'a'.repeat(64)

  it('accepts a valid credential with correct preimage', async () => {
    const { backend, preimage } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
    })

    const fragment = await rail.challenge('/api/route', { sats: 100 })
    const encoded = buildCredential(fragment.headers['WWW-Authenticate'], preimage)

    const result = await Promise.resolve(rail.verify({
      method: 'GET', path: '/api/route',
      headers: { authorization: `Payment ${encoded}` },
      ip: '127.0.0.1',
    }))

    expect(result.authenticated).toBe(true)
    expect(result.mode).toBe('per-request')
    expect(result.currency).toBe('sat')
  })

  it('rejects credential with tampered challenge ID', async () => {
    const { backend, preimage } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
    })

    const fragment = await rail.challenge('/api/route', { sats: 100 })
    const tampered = fragment.headers['WWW-Authenticate'].replace(/id="[^"]+"/, 'id="tampered"')
    const encoded = buildCredential(tampered, preimage)

    const result = await Promise.resolve(rail.verify({
      method: 'GET', path: '/api/route',
      headers: { authorization: `Payment ${encoded}` },
      ip: '127.0.0.1',
    }))

    expect(result.authenticated).toBe(false)
  })

  it('rejects credential with wrong preimage', async () => {
    const { backend } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
    })

    const fragment = await rail.challenge('/api/route', { sats: 100 })
    const encoded = buildCredential(fragment.headers['WWW-Authenticate'], 'ff'.repeat(32))

    const result = await Promise.resolve(rail.verify({
      method: 'GET', path: '/api/route',
      headers: { authorization: `Payment ${encoded}` },
      ip: '127.0.0.1',
    }))

    expect(result.authenticated).toBe(false)
  })

  it('rejects expired challenge', async () => {
    const { backend, preimage } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
      challengeExpirySecs: -1,
    })

    const fragment = await rail.challenge('/api/route', { sats: 100 })
    const encoded = buildCredential(fragment.headers['WWW-Authenticate'], preimage)

    const result = await Promise.resolve(rail.verify({
      method: 'GET', path: '/api/route',
      headers: { authorization: `Payment ${encoded}` },
      ip: '127.0.0.1',
    }))

    expect(result.authenticated).toBe(false)
  })

  it('rejects malformed base64url credential', async () => {
    const { backend } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'test.com',
      backend,
      storage: memoryStorage(),
    })

    const result = await Promise.resolve(rail.verify({
      method: 'GET', path: '/',
      headers: { authorization: 'Payment not-valid-base64url!!!' },
      ip: '127.0.0.1',
    }))

    expect(result.authenticated).toBe(false)
  })

  it('rejects credential missing required challenge fields', async () => {
    const { backend } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'test.com',
      backend,
      storage: memoryStorage(),
    })

    const cred = Buffer.from(JSON.stringify({ challenge: { id: 'x' }, payload: {} })).toString('base64url')
    const result = await Promise.resolve(rail.verify({
      method: 'GET', path: '/',
      headers: { authorization: `Payment ${cred}` },
      ip: '127.0.0.1',
    }))

    expect(result.authenticated).toBe(false)
  })

  it('rejects credential with invalid preimage format', async () => {
    const { backend } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
    })

    const fragment = await rail.challenge('/api/route', { sats: 100 })
    const encoded = buildCredential(fragment.headers['WWW-Authenticate'], 'not-hex')

    const result = await Promise.resolve(rail.verify({
      method: 'GET', path: '/api/route',
      headers: { authorization: `Payment ${encoded}` },
      ip: '127.0.0.1',
    }))

    expect(result.authenticated).toBe(false)
  })

  it('rejects a credential presented at a different route (cross-route replay)', async () => {
    const { backend, preimage } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
    })

    // Pay a 10-sat invoice for the cheap route…
    const fragment = await rail.challenge('/api/cheap', { sats: 10 })
    const encoded = buildCredential(fragment.headers['WWW-Authenticate'], preimage)

    // …then present the credential at the expensive route
    const result = await Promise.resolve(rail.verify({
      method: 'GET', path: '/api/expensive',
      headers: { authorization: `Payment ${encoded}` },
      ip: '127.0.0.1',
    }))

    expect(result.authenticated).toBe(false)
  })

  it('accepts a credential at the route it was issued for and reports amountPaid', async () => {
    const { backend, preimage } = knownHashBackend()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
    })

    const fragment = await rail.challenge('/api/route', { sats: 100 })
    const encoded = buildCredential(fragment.headers['WWW-Authenticate'], preimage)

    const result = await Promise.resolve(rail.verify({
      method: 'GET', path: '/api/route',
      headers: { authorization: `Payment ${encoded}` },
      ip: '127.0.0.1',
    }))

    expect(result.authenticated).toBe(true)
    expect(result.amountPaid).toBe(100)
  })

  it('rejects a pre-binding credential with no resource in the charge request', async () => {
    const { backend, preimage, paymentHash } = knownHashBackend()
    const hmac = hmacSecret
    const rail = createIETFPaymentRail({
      hmacSecret: hmac,
      realm: 'api.example.com',
      backend,
      storage: memoryStorage(),
    })

    // Build a legacy-format charge request (no resource field) with a valid HMAC
    const request = encodeJCS({
      amount: '100',
      currency: 'sat',
      methodDetails: { invoice: 'lnbc100n1mock', paymentHash, network: 'mainnet' },
    })
    const expires = new Date(Date.now() + 60_000).toISOString()
    const params: IETFChallengeParams = {
      realm: 'api.example.com', method: 'lightning', intent: 'charge', request, expires,
    }
    const id = computeChallengeId(hmac, params)
    const header = `Payment id="${id}", realm="api.example.com", method="lightning", intent="charge", request="${request}", expires="${expires}"`
    const encoded = buildCredential(header, preimage)

    const result = await Promise.resolve(rail.verify({
      method: 'GET', path: '/api/route',
      headers: { authorization: `Payment ${encoded}` },
      ip: '127.0.0.1',
    }))

    expect(result.authenticated).toBe(false)
  })
})

// --- Payment-Receipt tests ---

describe('Payment-Receipt header', () => {
  it('produces a valid base64url-encoded receipt', () => {
    const header = buildReceiptHeader({
      method: 'lightning',
      reference: 'ab'.repeat(32),
      challengeId: 'test-challenge-id',
    })

    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString())
    expect(decoded.status).toBe('success')
    expect(decoded.method).toBe('lightning')
    expect(decoded.reference).toBe('ab'.repeat(32))
    expect(decoded.challengeId).toBe('test-challenge-id')
    expect(decoded.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('omits challengeId when not provided', () => {
    const header = buildReceiptHeader({
      method: 'lightning',
      reference: 'ab'.repeat(32),
    })

    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString())
    expect(decoded.challengeId).toBeUndefined()
  })
})

// --- encodeJCS tests ---

describe('encodeJCS', () => {
  it('produces base64url output', () => {
    const encoded = encodeJCS({ amount: '1000', currency: 'sat' })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('sorts keys deterministically', () => {
    const a = encodeJCS({ z: '1', a: '2' })
    const b = encodeJCS({ a: '2', z: '1' })
    expect(a).toBe(b)
  })

  it('round-trips via base64url decode', () => {
    const obj = { amount: '1000', currency: 'sat' }
    const encoded = encodeJCS(obj)
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString())
    expect(decoded).toEqual(obj)
  })
})
