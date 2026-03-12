import { newMacaroon, importMacaroon } from 'macaroon'

const LOCATION = 'toll-booth'
const KNOWN_CAVEATS = new Set(['payment_hash', 'credit_balance'])

/**
 * Mints a new macaroon encoding a payment hash and credit balance.
 *
 * @param rootKey - Hex-encoded 32-byte root key.
 * @param paymentHash - The Lightning payment hash (hex string).
 * @param creditBalanceSats - The credit balance in satoshis.
 * @returns Base64-encoded binary macaroon.
 */
export function mintMacaroon(rootKey: string, paymentHash: string, creditBalanceSats: number, caveats?: string[]): string {
  const keyBytes = hexToBytes(rootKey)
  const m = newMacaroon({
    identifier: paymentHash,
    location: LOCATION,
    rootKey: keyBytes,
    version: 2,
  })
  m.addFirstPartyCaveat(`payment_hash = ${paymentHash}`)
  m.addFirstPartyCaveat(`credit_balance = ${creditBalanceSats}`)
  if (caveats) {
    for (const caveat of caveats) {
      if (!caveat.includes(' = ')) {
        throw new Error(`Invalid caveat format (must contain " = "): ${caveat}`)
      }
      m.addFirstPartyCaveat(caveat)
    }
  }
  return uint8ToBase64(m.exportBinary())
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
}

/**
 * Verifies a macaroon's cryptographic signature and extracts its caveats.
 *
 * @param rootKey - Hex-encoded 32-byte root key used to mint the macaroon.
 * @param macaroonBase64 - Base64-encoded binary macaroon.
 * @returns A VerifyResult indicating validity and parsed caveat values.
 */
export function verifyMacaroon(rootKey: string, macaroonBase64: string): VerifyResult {
  try {
    const keyBytes = hexToBytes(rootKey)
    const m = importMacaroon(base64ToUint8(macaroonBase64))

    // Track caveat counts to reject duplicates (prevents attacker-appended overrides)
    const seen = new Map<string, number>()
    m.verify(keyBytes, (condition: string) => {
      const eqIdx = condition.indexOf(' = ')
      if (eqIdx === -1) return 'malformed caveat'
      const key = condition.slice(0, eqIdx)
      if (!KNOWN_CAVEATS.has(key)) return 'unknown caveat'
      seen.set(key, (seen.get(key) ?? 0) + 1)
      if (seen.get(key)! > 1) return 'duplicate caveat'
      return null
    }, [])

    // Use the immutable identifier as the authoritative payment hash —
    // it is set at mint time and covered by the root signature.
    const json = m.exportJSON() as Record<string, unknown>
    const identifier = json.i as string

    const caveats = parseCaveats(macaroonBase64)

    // Cross-check: the payment_hash caveat must match the identifier
    if (caveats.payment_hash && caveats.payment_hash !== identifier) {
      return { valid: false }
    }

    return {
      valid: true,
      paymentHash: identifier,
      creditBalance: caveats.credit_balance !== undefined
        ? parseInt(caveats.credit_balance, 10)
        : undefined,
    }
  } catch {
    return { valid: false }
  }
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

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function base64ToUint8(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}
