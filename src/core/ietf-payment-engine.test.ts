import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { createTollBooth } from './toll-booth.js'
import { createL402Rail } from './l402-rail.js'
import { createIETFPaymentRail } from './ietf-payment.js'
import { memoryStorage } from '../storage/memory.js'
import type { LightningBackend } from '../types.js'
import type { PaymentRail } from './payment-rail.js'

// --- Test helpers ---

const preimage = Buffer.alloc(32, 0xcd)
const paymentHash = createHash('sha256').update(preimage).digest('hex')
const hmacSecret = 'a'.repeat(64)
const rootKey = 'b'.repeat(64)

function backend(): LightningBackend {
  return {
    async createInvoice(amountSats: number) {
      return { bolt11: `lnbc${amountSats}n1mock`, paymentHash }
    },
    async checkInvoice() {
      return { paid: true, preimage: preimage.toString('hex') }
    },
  }
}

function parseWWWAuth(header: string): Record<string, string> {
  const params: Record<string, string> = {}
  for (const match of header.matchAll(/(\w+)="([^"]+)"/g)) {
    params[match[1]] = match[2]
  }
  return params
}

function buildCredential(header: string, pre: string): string {
  // Extract only the Payment scheme part from a possibly combined header
  const paymentPart = header.split(', Payment ').pop()!
  const fullPart = paymentPart.startsWith('Payment ') ? paymentPart : `Payment ${paymentPart}`
  const params = parseWWWAuth(fullPart)
  const credential = {
    challenge: {
      id: params.id,
      realm: params.realm,
      method: params.method,
      intent: params.intent,
      request: params.request,
      expires: params.expires,
    },
    payload: { preimage: pre },
  }
  return Buffer.from(JSON.stringify(credential)).toString('base64url')
}

// --- Tests ---

describe('Payment-Receipt injection', () => {
  it('includes Payment-Receipt header on IETF Payment authenticated response', async () => {
    const storage = memoryStorage()
    const rail = createIETFPaymentRail({
      hmacSecret,
      realm: 'test.com',
      backend: backend(),
      storage,
    })

    const engine = createTollBooth({
      backend: backend(),
      storage,
      pricing: { '/api': 100 },
      upstream: 'http://localhost:8080',
      rootKey,
      rails: [rail],
    })

    // Get challenge
    const challenge = await engine.handle({
      method: 'GET', path: '/api', headers: {}, ip: '127.0.0.1',
    })
    expect(challenge.action).toBe('challenge')
    if (challenge.action !== 'challenge') throw new Error('expected challenge')

    // Build credential
    const encoded = buildCredential(challenge.headers['WWW-Authenticate'], preimage.toString('hex'))

    // Authenticate
    const result = await engine.handle({
      method: 'GET', path: '/api',
      headers: { authorization: `Payment ${encoded}` },
      ip: '127.0.0.1',
    })

    expect(result.action).toBe('proxy')
    if (result.action !== 'proxy') throw new Error('expected proxy')

    // Verify receipt
    expect(result.headers['Payment-Receipt']).toBeDefined()
    const receipt = JSON.parse(Buffer.from(result.headers['Payment-Receipt'], 'base64url').toString())
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('lightning')
    expect(receipt.reference).toBe(paymentHash)
    expect(receipt.timestamp).toBeDefined()

    // Verify cache control
    expect(result.headers['Cache-Control']).toBe('private')
  })
})

describe('Multi-value WWW-Authenticate', () => {
  function stubRail(type: string, headerValue: string): PaymentRail {
    return {
      type,
      creditSupported: false,
      detect: () => false,
      verify: () => ({ authenticated: false, paymentId: '', mode: 'per-request' as const, currency: 'sat' as const }),
      async challenge() {
        return {
          headers: { 'WWW-Authenticate': headerValue },
          body: { [type]: true },
        }
      },
    }
  }

  it('concatenates WWW-Authenticate from multiple rails', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      storage,
      pricing: { '/api': 100 },
      upstream: 'http://localhost:8080',
      rootKey,
      rails: [
        stubRail('l402', 'L402 macaroon="abc", invoice="lnbc100"'),
        stubRail('payment', 'Payment id="xyz", realm="test"'),
      ],
    })

    const result = await engine.handle({
      method: 'GET', path: '/api', headers: {}, ip: '127.0.0.1',
    })

    expect(result.action).toBe('challenge')
    if (result.action !== 'challenge') throw new Error('expected challenge')

    const auth = result.headers['WWW-Authenticate']
    expect(auth).toContain('L402 macaroon="abc"')
    expect(auth).toContain('Payment id="xyz"')
  })

  it('works with a single rail (no concatenation needed)', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      storage,
      pricing: { '/api': 100 },
      upstream: 'http://localhost:8080',
      rootKey,
      rails: [stubRail('l402', 'L402 macaroon="abc"')],
    })

    const result = await engine.handle({
      method: 'GET', path: '/api', headers: {}, ip: '127.0.0.1',
    })

    if (result.action !== 'challenge') throw new Error('expected challenge')
    expect(result.headers['WWW-Authenticate']).toBe('L402 macaroon="abc"')
  })
})

describe('Dual-scheme challenge (L402 + IETF Payment)', () => {
  it('402 response contains both L402 and Payment in header and body', async () => {
    const storage = memoryStorage()
    const rails = [
      createL402Rail({ rootKey, storage, defaultAmount: 1000, backend: backend() }),
      createIETFPaymentRail({ hmacSecret, realm: 'test.com', backend: backend(), storage }),
    ]

    const engine = createTollBooth({
      backend: backend(),
      storage,
      pricing: { '/api': 100 },
      upstream: 'http://localhost:8080',
      rootKey,
      rails,
    })

    const result = await engine.handle({
      method: 'GET', path: '/api', headers: {}, ip: '127.0.0.1',
    })

    expect(result.action).toBe('challenge')
    if (result.action !== 'challenge') throw new Error('expected challenge')

    // Both schemes in WWW-Authenticate header
    const auth = result.headers['WWW-Authenticate']
    expect(auth).toContain('L402 ')
    expect(auth).toContain('Payment ')

    // Both schemes in body for agent discoverability
    expect(result.body.l402).toBeDefined()
    expect(result.body.ietf_payment).toBeDefined()
  })

  it('L402 client can still authenticate against dual-scheme booth', async () => {
    const storage = memoryStorage()
    const rails = [
      createL402Rail({ rootKey, storage, defaultAmount: 1000, backend: backend() }),
      createIETFPaymentRail({ hmacSecret, realm: 'test.com', backend: backend(), storage }),
    ]

    const engine = createTollBooth({
      backend: backend(),
      storage,
      pricing: { '/api': 100 },
      upstream: 'http://localhost:8080',
      rootKey,
      rails,
    })

    // Get challenge
    const challenge = await engine.handle({
      method: 'GET', path: '/api', headers: {}, ip: '127.0.0.1',
    })
    if (challenge.action !== 'challenge') throw new Error('expected challenge')

    // Extract L402 macaroon from body
    const l402 = challenge.body.l402 as Record<string, string>
    const macaroon = l402.macaroon
    const pre = preimage.toString('hex')

    // Authenticate via L402
    const result = await engine.handle({
      method: 'GET', path: '/api',
      headers: { authorization: `L402 ${macaroon}:${pre}` },
      ip: '127.0.0.1',
    })

    expect(result.action).toBe('proxy')
    if (result.action !== 'proxy') throw new Error('expected proxy')
    // L402 does not get Payment-Receipt
    expect(result.headers['Payment-Receipt']).toBeUndefined()
  })

  it('IETF Payment client can authenticate against dual-scheme booth', async () => {
    const storage = memoryStorage()
    const rails = [
      createL402Rail({ rootKey, storage, defaultAmount: 1000, backend: backend() }),
      createIETFPaymentRail({ hmacSecret, realm: 'test.com', backend: backend(), storage }),
    ]

    const engine = createTollBooth({
      backend: backend(),
      storage,
      pricing: { '/api': 100 },
      upstream: 'http://localhost:8080',
      rootKey,
      rails,
    })

    // Get challenge
    const challenge = await engine.handle({
      method: 'GET', path: '/api', headers: {}, ip: '127.0.0.1',
    })
    if (challenge.action !== 'challenge') throw new Error('expected challenge')

    // Build IETF Payment credential
    const encoded = buildCredential(challenge.headers['WWW-Authenticate'], preimage.toString('hex'))

    // Authenticate via IETF Payment
    const result = await engine.handle({
      method: 'GET', path: '/api',
      headers: { authorization: `Payment ${encoded}` },
      ip: '127.0.0.1',
    })

    expect(result.action).toBe('proxy')
    if (result.action !== 'proxy') throw new Error('expected proxy')
    // IETF Payment gets Payment-Receipt
    expect(result.headers['Payment-Receipt']).toBeDefined()
  })
})
