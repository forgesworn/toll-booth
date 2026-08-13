import { randomBytes } from 'node:crypto'
import { newMacaroon, importMacaroon } from 'macaroon'
import type { Macaroon } from 'macaroon'

const LOCATION = 'toll-booth'

/**
 * Aperture-compatible L402 identifier layout (version 0):
 *   [0..1]   uint16 big-endian version (0)
 *   [2..33]  32-byte payment hash
 *   [34..65] 32-byte random token ID
 */
const L402_ID_VERSION = 0
const L402_ID_SIZE = 66
const KNOWN_CAVEATS = new Set(['payment_hash', 'credit_balance', 'currency', 'route', 'expires', 'ip'])

/** Caveat keys that encode monetary value and must not be set via the caveats parameter. */
const RESERVED_CAVEAT_KEYS = new Set(['payment_hash', 'credit_balance', 'currency'])

/**
 * Mints a new macaroon encoding a payment hash and credit balance.
 *
 * @param rootKey - Hex-encoded 32-byte root key.
 * @param paymentHash - The Lightning payment hash (hex string).
 * @param creditBalanceSats - The credit balance in satoshis.
 * @returns Base64-encoded binary macaroon.
 */
/** Maximum number of custom caveats allowed per macaroon. */
const MAX_CUSTOM_CAVEATS = 16
const MAX_CAVEAT_LENGTH = 1024
const MAX_MACAROON_BYTES = 24_576
const HEX_32_BYTES = /^[0-9a-f]{64}$/i

export function mintMacaroon(rootKey: string, paymentHash: string, creditBalanceSats: number, caveats?: string[], currency?: string): string {
  if (!HEX_32_BYTES.test(rootKey)) throw new Error('Root key must be exactly 32 bytes of hex')
  if (!HEX_32_BYTES.test(paymentHash)) throw new Error('Payment hash must be exactly 32 bytes of hex')
  if (!Number.isSafeInteger(creditBalanceSats) || creditBalanceSats < 0) {
    throw new Error('Credit balance must be a non-negative safe integer')
  }
  if (currency !== undefined && currency !== 'sat' && currency !== 'usd') {
    throw new Error('Currency must be sat or usd')
  }
  const keyBytes = hexToBytes(rootKey)
  const m = newMacaroon({
    identifier: encodeL402Identifier(paymentHash),
    location: LOCATION,
    rootKey: keyBytes,
    version: 2,
  })
  m.addFirstPartyCaveat(`payment_hash = ${paymentHash}`)
  m.addFirstPartyCaveat(`credit_balance = ${creditBalanceSats}`)
  m.addFirstPartyCaveat(`currency = ${currency ?? 'sat'}`)
  if (caveats) {
    if (caveats.length > MAX_CUSTOM_CAVEATS) {
      throw new Error(`Too many caveats: maximum ${MAX_CUSTOM_CAVEATS} custom caveats allowed`)
    }
    const seenKeys = new Set<string>()
    for (const caveat of caveats) {
      if (!caveat.includes(' = ')) {
        throw new Error(`Invalid caveat format (must contain " = "): ${caveat}`)
      }
      if (caveat.length > MAX_CAVEAT_LENGTH) {
        throw new Error(`Caveat exceeds maximum length of ${MAX_CAVEAT_LENGTH} characters`)
      }
      const key = caveat.slice(0, caveat.indexOf(' = ')).trim()
      if (!key) throw new Error('Caveat key must not be empty')
      if (RESERVED_CAVEAT_KEYS.has(key)) {
        throw new Error(`Caveat key "${key}" is reserved and cannot be overridden`)
      }
      if (seenKeys.has(key)) throw new Error(`Duplicate caveat key: ${key}`)
      seenKeys.add(key)
      m.addFirstPartyCaveat(caveat)
    }
  }
  return uint8ToBase64(serializeMacaroonV2(m))
}

/**
 * Linear, bounded Macaroon v2 binary serialization.
 *
 * macaroon@3.0.4's ByteBuffer does not retain its capacity and therefore
 * doubles on every field append. Keeping this small encoder here avoids an
 * exponential allocation path while preserving the standard v2 wire format.
 * It is intentionally not re-exported from the package entrypoint.
 */
export function serializeMacaroonV2(macaroon: Macaroon): Uint8Array {
  const output: number[] = [2]
  const encoder = new TextEncoder()

  function appendUvarint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MACAROON_BYTES) {
      throw new Error('Macaroon field length is out of bounds')
    }
    while (value >= 0x80) {
      output.push((value & 0x7f) | 0x80)
      value = Math.floor(value / 128)
    }
    output.push(value)
  }

  function appendField(type: 0 | 1 | 2 | 4 | 6, bytes?: Uint8Array): void {
    output.push(type)
    if (type !== 0) {
      const value = bytes ?? new Uint8Array()
      appendUvarint(value.length)
      for (const byte of value) output.push(byte)
    }
    if (output.length > MAX_MACAROON_BYTES) throw new Error('Macaroon exceeds maximum size')
  }

  if (macaroon.location) appendField(1, encoder.encode(macaroon.location))
  appendField(2, macaroon.identifier)
  appendField(0)
  for (const caveat of macaroon.caveats) {
    if (caveat.location) appendField(1, encoder.encode(caveat.location))
    appendField(2, caveat.identifier)
    if (caveat.vid) appendField(4, caveat.vid)
    appendField(0)
  }
  appendField(0)
  appendField(6, macaroon.signature)
  return Uint8Array.from(output)
}

/**
 * Context provided to verifyMacaroon for built-in caveat checks.
 */
export interface VerifyContext {
  /** The request path, checked against any `route` caveat. */
  path: string
  /** The client IP address, checked against any `ip` caveat. */
  ip: string
  /** Override the current time for `expires` caveat checks (useful in tests). */
  now?: Date
}

/**
 * Result of macaroon verification.
 */
export interface VerifyResult {
  /** Whether the macaroon signature and caveats are valid. */
  valid: boolean
  /** The payment hash extracted from the macaroon, if valid. */
  paymentHash?: string
  /** The credit balance in satoshis extracted from the macaroon, if valid. */
  creditBalance?: number
  /** The currency the credit balance is denominated in ('sat' or 'usd'). */
  currency?: string
  /** Any non-built-in caveats present on the macaroon. */
  customCaveats?: Record<string, string>
}

/**
 * Verifies a macaroon's cryptographic signature and extracts its caveats.
 *
 * @param rootKey - Hex-encoded 32-byte root key used to mint the macaroon.
 * @param macaroonBase64 - Base64-encoded binary macaroon.
 * @param context - Optional context for built-in caveat verification (route, expires, ip).
 * @returns A VerifyResult indicating validity and parsed caveat values.
 */
export function verifyMacaroon(rootKey: string, macaroonBase64: string, context?: VerifyContext): VerifyResult {
  try {
    const keyBytes = hexToBytes(rootKey)
    const m = importMacaroon(base64ToUint8(macaroonBase64))

    // Track caveat counts to reject duplicates (prevents attacker-appended overrides)
    const seen = new Map<string, number>()
    m.verify(keyBytes, (condition: string) => {
      const eqIdx = condition.indexOf(' = ')
      if (eqIdx === -1) return 'malformed caveat'
      const key = condition.slice(0, eqIdx)
      seen.set(key, (seen.get(key) ?? 0) + 1)
      if (seen.get(key)! > 1) return 'duplicate caveat'
      return null
    }, [])

    // Decode the aperture-compatible binary identifier to extract the
    // payment hash.  The identifier is set at mint time and covered by
    // the root signature, so it cannot be tampered with.
    const paymentHash = decodeL402Identifier(m.identifier)
    if (!paymentHash) return { valid: false }

    const caveats = parseCaveats(macaroonBase64)

    // Cross-check: the payment_hash caveat must match the identifier
    if (caveats.payment_hash && caveats.payment_hash !== paymentHash) {
      return { valid: false }
    }

    if (context) {
      if (caveats.route && !matchRoute(caveats.route, context.path)) {
        return { valid: false }
      }
      if (caveats.expires) {
        const now = context.now ?? new Date()
        if (new Date(caveats.expires) <= now) {
          return { valid: false }
        }
      }
      if (caveats.ip && caveats.ip !== context.ip) {
        return { valid: false }
      }
    }

    const customCaveats: Record<string, string> = {}
    for (const [key, value] of Object.entries(caveats)) {
      if (!KNOWN_CAVEATS.has(key)) {
        customCaveats[key] = value
      }
    }

    let creditBalance: number | undefined
    if (caveats.credit_balance !== undefined) {
      const parsed = parseInt(caveats.credit_balance, 10)
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return { valid: false }
      }
      creditBalance = parsed
    }

    const currency = caveats.currency ?? 'sat'

    return {
      valid: true,
      paymentHash,
      creditBalance,
      currency,
      customCaveats: Object.keys(customCaveats).length > 0 ? customCaveats : undefined,
    }
  } catch {
    return { valid: false }
  }
}

function matchRoute(pattern: string, path: string): boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    return path === prefix || path.startsWith(prefix + '/')
  }
  return pattern === path
}

/**
 * Parses first-party caveats from a macaroon into a key/value map.
 *
 * Caveats must follow the `key = value` format. Caveats that do not
 * match this pattern are silently ignored.
 *
 * @param macaroonBase64 - Base64-encoded binary macaroon.
 * @returns A record of caveat keys to their string values.
 */
export function parseCaveats(macaroonBase64: string): Record<string, string> {
  const m = importMacaroon(base64ToUint8(macaroonBase64))
  const result: Record<string, string> = {}
  // caveats is an array of objects with an identifier field (Uint8Array)
  const caveats = m.caveats as Array<{ identifier: Uint8Array }>
  for (const c of caveats) {
    const raw = new TextDecoder().decode(c.identifier)
    const eqIdx = raw.indexOf(' = ')
    if (eqIdx !== -1) {
      const key = raw.slice(0, eqIdx).trim()
      // First-occurrence-wins: server-set caveats come first in the chain,
      // so any attacker-appended duplicates are ignored.
      if (!Object.hasOwn(result, key)) {
        result[key] = raw.slice(eqIdx + 3).trim()
      }
    }
  }
  return result
}

function encodeL402Identifier(paymentHash: string): Uint8Array {
  const id = new Uint8Array(L402_ID_SIZE)
  id[0] = (L402_ID_VERSION >> 8) & 0xff
  id[1] = L402_ID_VERSION & 0xff
  id.set(hexToBytes(paymentHash), 2)
  id.set(randomBytes(32), 34)
  return id
}

function decodeL402Identifier(id: Uint8Array): string | undefined {
  if (id.length < L402_ID_SIZE) return undefined
  const version = (id[0] << 8) | id[1]
  if (version !== L402_ID_VERSION) return undefined
  return bytesToHex(id.slice(2, 34))
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function base64ToUint8(b64: string): Uint8Array {
  if (b64.length === 0 || b64.length > Math.ceil(MAX_MACAROON_BYTES / 3) * 4) {
    throw new Error('Macaroon is empty or exceeds maximum size')
  }
  if (b64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) {
    throw new Error('Macaroon is not canonical base64')
  }
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
  if (bytes.length > MAX_MACAROON_BYTES) throw new Error('Macaroon exceeds maximum size')
  return bytes
}
