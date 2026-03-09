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

  it('rejects macaroon with appended unknown caveat', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000)
    const tampered = appendCaveat(mac, 'admin = true')
    const result = verifyMacaroon(rootKey, tampered)
    expect(result.valid).toBe(false)
  })

  it('uses identifier as authoritative payment hash, not caveat value', () => {
    const mac = mintMacaroon(rootKey, paymentHash, 1000)
    const result = verifyMacaroon(rootKey, mac)
    expect(result.valid).toBe(true)
    expect(result.paymentHash).toBe(paymentHash) // From identifier, not caveat
  })
})
