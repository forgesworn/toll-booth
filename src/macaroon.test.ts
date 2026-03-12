import { describe, it, expect } from 'vitest'
import { importMacaroon } from 'macaroon'
import { mintMacaroon, verifyMacaroon, parseCaveats } from './macaroon.js'

/** Appends a first-party caveat to a valid macaroon (simulates attacker). */
function appendCaveat(macaroonBase64: string, caveat: string): string {
  const m = importMacaroon(new Uint8Array(Buffer.from(macaroonBase64, 'base64')))
  m.addFirstPartyCaveat(caveat)
  return Buffer.from(m.exportBinary()).toString('base64')
}

describe('mintMacaroon', () => {
  const rootKey = 'a'.repeat(64)

  it('mints a macaroon with payment_hash caveat', () => {
    const paymentHash = 'b'.repeat(64)
    const m = mintMacaroon(rootKey, paymentHash, 1000)
    expect(m).toBeTruthy()
    expect(typeof m).toBe('string')
  })

  it('includes credit_balance caveat', () => {
    const paymentHash = 'b'.repeat(64)
    const m = mintMacaroon(rootKey, paymentHash, 1000)
    const caveats = parseCaveats(m)
    expect(caveats.payment_hash).toBe(paymentHash)
    expect(caveats.credit_balance).toBe('1000')
  })
})

describe('verifyMacaroon', () => {
  const rootKey = 'a'.repeat(64)
  const paymentHash = 'b'.repeat(64)

  it('verifies a valid macaroon', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000)
    const result = verifyMacaroon(rootKey, mac)
    expect(result.valid).toBe(true)
    expect(result.paymentHash).toBe(paymentHash)
    expect(result.creditBalance).toBe(1000)
  })

  it('rejects a macaroon with wrong root key', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000)
    const result = verifyMacaroon('c'.repeat(64), mac)
    expect(result.valid).toBe(false)
  })

  it('rejects a tampered macaroon', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000)
    const tampered = mac.slice(0, -2) + 'XX'
    const result = verifyMacaroon(rootKey, tampered)
    expect(result.valid).toBe(false)
  })
})

describe('parseCaveats', () => {
  const rootKey = 'a'.repeat(64)

  it('parses key=value caveats from a macaroon', () => {
    const mac = mintMacaroon(rootKey, 'b'.repeat(64), 500)
    const caveats = parseCaveats(mac)
    expect(caveats.payment_hash).toBe('b'.repeat(64))
    expect(caveats.credit_balance).toBe('500')
  })

  it('uses first-occurrence-wins for duplicate caveat keys', () => {
    const mac = mintMacaroon(rootKey, 'b'.repeat(64), 500)
    const tampered = appendCaveat(mac, 'credit_balance = 999999')
    const caveats = parseCaveats(tampered)
    expect(caveats.credit_balance).toBe('500') // Server-set value, not attacker's
  })
})

describe('mintMacaroon with caveats', () => {
  const rootKey = 'a'.repeat(64)
  const paymentHash = 'b'.repeat(64)

  it('mints with additional caveats', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000, ['route = /send', 'sender = example.com'])
    const caveats = parseCaveats(mac)
    expect(caveats.route).toBe('/send')
    expect(caveats.sender).toBe('example.com')
    expect(caveats.payment_hash).toBe(paymentHash)
    expect(caveats.credit_balance).toBe('1000')
  })

  it('mints normally when caveats omitted', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000)
    const caveats = parseCaveats(mac)
    expect(caveats.payment_hash).toBe(paymentHash)
    expect(caveats.credit_balance).toBe('1000')
    expect(Object.keys(caveats)).toHaveLength(2)
  })

  it('mints normally with empty caveats array', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000, [])
    const caveats = parseCaveats(mac)
    expect(Object.keys(caveats)).toHaveLength(2)
  })

  it('rejects caveats without = separator', () => {
    expect(() => mintMacaroon(rootKey, paymentHash, 1000, ['invalid']))
      .toThrow()
  })
})

describe('caveat tampering prevention', () => {
  const rootKey = 'a'.repeat(64)
  const paymentHash = 'b'.repeat(64)

  it('rejects macaroon with appended duplicate credit_balance caveat', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000)
    const tampered = appendCaveat(mac, 'credit_balance = 999999')
    const result = verifyMacaroon(rootKey, tampered)
    expect(result.valid).toBe(false)
  })

  it('rejects macaroon with appended duplicate payment_hash caveat', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000)
    const tampered = appendCaveat(mac, `payment_hash = ${'c'.repeat(64)}`)
    const result = verifyMacaroon(rootKey, tampered)
    expect(result.valid).toBe(false)
  })

  it('allows macaroon with appended custom caveat (attenuation)', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000)
    const attenuated = appendCaveat(mac, 'admin = true')
    const result = verifyMacaroon(rootKey, attenuated)
    expect(result.valid).toBe(true)
    expect(result.customCaveats).toEqual({ admin: 'true' })
  })
})

describe('verifyMacaroon with VerifyContext', () => {
  const rootKey = 'a'.repeat(64)
  const paymentHash = 'b'.repeat(64)

  it('verifies route caveat (exact match)', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000, ['route = /send'])
    const result = verifyMacaroon(rootKey, mac, { path: '/send', ip: '1.2.3.4' })
    expect(result.valid).toBe(true)
  })

  it('rejects route caveat mismatch', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000, ['route = /send'])
    const result = verifyMacaroon(rootKey, mac, { path: '/other', ip: '1.2.3.4' })
    expect(result.valid).toBe(false)
  })

  it('verifies route caveat with trailing wildcard', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000, ['route = /api/*'])
    expect(verifyMacaroon(rootKey, mac, { path: '/api/send', ip: '1.2.3.4' }).valid).toBe(true)
    expect(verifyMacaroon(rootKey, mac, { path: '/api/status', ip: '1.2.3.4' }).valid).toBe(true)
    expect(verifyMacaroon(rootKey, mac, { path: '/other', ip: '1.2.3.4' }).valid).toBe(false)
  })

  it('verifies expires caveat (not expired)', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const mac = mintMacaroon(rootKey, paymentHash, 1000, [`expires = ${future}`])
    const result = verifyMacaroon(rootKey, mac, { path: '/', ip: '1.2.3.4' })
    expect(result.valid).toBe(true)
  })

  it('rejects expired macaroon', () => {
    const past = new Date(Date.now() - 1000).toISOString()
    const mac = mintMacaroon(rootKey, paymentHash, 1000, [`expires = ${past}`])
    const result = verifyMacaroon(rootKey, mac, { path: '/', ip: '1.2.3.4' })
    expect(result.valid).toBe(false)
  })

  it('verifies ip caveat', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000, ['ip = 1.2.3.4'])
    expect(verifyMacaroon(rootKey, mac, { path: '/', ip: '1.2.3.4' }).valid).toBe(true)
    expect(verifyMacaroon(rootKey, mac, { path: '/', ip: '5.6.7.8' }).valid).toBe(false)
  })

  it('skips built-in verification when context omitted (backwards compatible)', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000, ['route = /send'])
    const result = verifyMacaroon(rootKey, mac)
    expect(result.valid).toBe(true)
  })

  it('uses injectable now for expires testing', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000, ['expires = 2026-06-01T00:00:00Z'])
    const before = verifyMacaroon(rootKey, mac, { path: '/', ip: '1.2.3.4', now: new Date('2026-05-01') })
    const after = verifyMacaroon(rootKey, mac, { path: '/', ip: '1.2.3.4', now: new Date('2026-07-01') })
    expect(before.valid).toBe(true)
    expect(after.valid).toBe(false)
  })

  it('uses identifier as authoritative payment hash, not caveat value', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000)
    const result = verifyMacaroon(rootKey, mac)
    expect(result.valid).toBe(true)
    expect(result.paymentHash).toBe(paymentHash) // From identifier, not caveat
  })
})

describe('custom caveat extraction', () => {
  const rootKey = 'a'.repeat(64)
  const paymentHash = 'b'.repeat(64)

  it('extracts custom caveats into customCaveats', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000, ['sender = example.com', 'plan = premium'])
    const result = verifyMacaroon(rootKey, mac, { path: '/', ip: '1.2.3.4' })
    expect(result.valid).toBe(true)
    expect(result.customCaveats).toEqual({ sender: 'example.com', plan: 'premium' })
  })

  it('returns undefined customCaveats when none present', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000)
    const result = verifyMacaroon(rootKey, mac, { path: '/', ip: '1.2.3.4' })
    expect(result.customCaveats).toBeUndefined()
  })

  it('does not include built-in caveats in customCaveats', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000, ['route = /api/*', 'model = llama3'])
    const result = verifyMacaroon(rootKey, mac, { path: '/api/chat', ip: '1.2.3.4' })
    expect(result.valid).toBe(true)
    expect(result.customCaveats).toEqual({ model: 'llama3' })
    expect(result.customCaveats).not.toHaveProperty('route')
  })
})
