// src/core/ietf-payment.ts
//
// IETF Payment authentication rail (draft-ryan-httpauth-payment-01).
// Implements the Lightning charge intent alongside existing L402/x402/xcashu rails.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { StorageBackend } from '../storage/interface.js'
import type { LightningBackend } from '../types.js'
import type { TollBoothRequest } from './types.js'
import type { PaymentRail, PriceInfo, ChallengeFragment, RailVerifyResult } from './payment-rail.js'

// --- Types matching IETF draft-ryan-httpauth-payment-01 ---

export interface IETFChallengeParams {
  realm: string
  method: string
  intent: string
  request: string  // base64url-encoded JCS JSON
  expires?: string // RFC 3339
  digest?: string  // RFC 9530 content digest
  description?: string
  opaque?: string  // base64url-encoded JCS JSON
}

export interface IETFCredential {
  challenge: IETFChallengeParams & { id: string }
  source?: string  // payer identifier (DID recommended)
  payload: Record<string, unknown>  // method-specific proof
}

export interface IETFReceipt {
  status: 'success'
  method: string
  timestamp: string
  reference: string
  challengeId?: string
}

/** Lightning-specific charge request (embedded in challenge `request` param). */
export interface LightningChargeRequest {
  amount: string
  currency: string
  methodDetails: {
    invoice: string
    paymentHash: string
    network: string
  }
}

/** Lightning-specific charge payload (embedded in credential `payload`). */
export interface LightningChargePayload {
  preimage: string
}

// --- HMAC-SHA256 challenge binding ---

/**
 * Compute a stateless challenge ID via HMAC-SHA256.
 *
 * Uses the 7-slot positional scheme from the IETF draft:
 *   realm | method | intent | request | expires | digest | opaque
 *
 * Optional fields use empty string when absent, preventing
 * ambiguity between different parameter combinations.
 */
export function computeChallengeId(
  secret: string,
  params: IETFChallengeParams,
): string {
  const input = [
    params.realm,
    params.method,
    params.intent,
    params.request,
    params.expires ?? '',
    params.digest ?? '',
    params.opaque ?? '',
  ].join('|')

  const hmac = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(input)
    .digest()

  return hmac.toString('base64url')
}

/**
 * Verify a challenge ID using timing-safe comparison.
 */
export function verifyChallengeId(
  secret: string,
  id: string,
  params: IETFChallengeParams,
): boolean {
  const expected = computeChallengeId(secret, params)
  const idBuf = Buffer.from(id)
  const expectedBuf = Buffer.from(expected)
  if (idBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(idBuf, expectedBuf)
}

// --- Encoding helpers ---

/**
 * Encode an object as base64url JSON with sorted keys (minimal JCS).
 *
 * JCS = JSON Canonicalisation Scheme (RFC 8785). Recursively sorts
 * keys at every level for deterministic output.
 */
export function encodeJCS(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(sortKeys(obj))).toString('base64url')
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return sorted
}

// --- Payment-Receipt header ---

export interface ReceiptOptions {
  method: string
  reference: string
  challengeId?: string
}

export function buildReceiptHeader(opts: ReceiptOptions): string {
  const receipt: IETFReceipt = {
    status: 'success',
    method: opts.method,
    timestamp: new Date().toISOString(),
    reference: opts.reference,
    ...(opts.challengeId && { challengeId: opts.challengeId }),
  }
  return Buffer.from(JSON.stringify(receipt)).toString('base64url')
}

// --- Rail config ---

export interface IETFPaymentRailConfig {
  /** 64-char hex secret for HMAC challenge binding. */
  hmacSecret: string
  /** Protection space (e.g. 'api.example.com'). */
  realm: string
  /** Lightning backend for invoice creation/verification. */
  backend: LightningBackend
  /** Storage backend for settlement tracking. */
  storage: StorageBackend
  /** Challenge expiry in seconds. Default: 900 (15 minutes). */
  challengeExpirySecs?: number
  /** Human-readable service description for challenges. */
  description?: string
  /** Human-readable service name for invoice memos. */
  serviceName?: string
}

const DEFAULT_EXPIRY_SECS = 900

// --- Rail factory ---

export function createIETFPaymentRail(config: IETFPaymentRailConfig): PaymentRail {
  const { hmacSecret, realm, backend, storage: _storage, description } = config
  const expirySecs = config.challengeExpirySecs ?? DEFAULT_EXPIRY_SECS
  const label = config.serviceName ?? 'toll-booth'

  return {
    type: 'ietf-payment',
    creditSupported: false,

    canChallenge(price: PriceInfo): boolean {
      return price.sats !== undefined
    },

    detect(req: TollBoothRequest): boolean {
      const auth = req.headers.authorization ?? req.headers.Authorization ?? ''
      return /^Payment\s/i.test(auth)
    },

    async challenge(route: string, price: PriceInfo): Promise<ChallengeFragment> {
      const amountSats = price.sats!
      const invoice = await backend.createInvoice(amountSats, `${label}: ${route}`)

      const chargeRequest: LightningChargeRequest = {
        amount: String(amountSats),
        currency: 'sat',
        methodDetails: {
          invoice: invoice.bolt11,
          paymentHash: invoice.paymentHash,
          network: 'mainnet',
        },
      }

      const requestEncoded = encodeJCS(chargeRequest as unknown as Record<string, unknown>)
      const expires = new Date(Date.now() + expirySecs * 1000).toISOString()

      const challengeParams: IETFChallengeParams = {
        realm,
        method: 'lightning',
        intent: 'charge',
        request: requestEncoded,
        expires,
        ...(description && { description }),
      }

      const id = computeChallengeId(hmacSecret, challengeParams)

      const parts = [
        `id="${id}"`,
        `realm="${realm}"`,
        `method="lightning"`,
        `intent="charge"`,
        `request="${requestEncoded}"`,
        `expires="${expires}"`,
      ]
      if (description) parts.push(`description="${description}"`)

      return {
        headers: {
          'WWW-Authenticate': `Payment ${parts.join(', ')}`,
        },
        body: {
          ietf_payment: {
            scheme: 'Payment',
            description: 'Pay per request (IETF standard, stateless)',
            method: 'lightning',
            intent: 'charge',
            payment_hash: invoice.paymentHash,
            amount_sats: amountSats,
          },
        },
      }
    },

    verify(req: TollBoothRequest): RailVerifyResult {
      const auth = req.headers.authorization ?? req.headers.Authorization ?? ''
      const token = auth.replace(/^Payment\s+/i, '')

      // Decode base64url credential
      let credential: IETFCredential
      try {
        credential = JSON.parse(Buffer.from(token, 'base64url').toString())
      } catch {
        return { authenticated: false, paymentId: '', mode: 'per-request', currency: 'sat' }
      }

      const challenge = credential.challenge
      if (!challenge?.id || !challenge.realm || !challenge.method || !challenge.intent || !challenge.request) {
        return { authenticated: false, paymentId: '', mode: 'per-request', currency: 'sat' }
      }

      // Verify HMAC binding (stateless — no DB lookup)
      const params: IETFChallengeParams = {
        realm: challenge.realm,
        method: challenge.method,
        intent: challenge.intent,
        request: challenge.request,
        expires: challenge.expires,
        digest: challenge.digest,
        description: challenge.description,
        opaque: challenge.opaque,
      }
      if (!verifyChallengeId(hmacSecret, challenge.id, params)) {
        return { authenticated: false, paymentId: '', mode: 'per-request', currency: 'sat' }
      }

      // Check expiry
      if (challenge.expires) {
        const expiresAt = new Date(challenge.expires).getTime()
        if (isNaN(expiresAt) || Date.now() > expiresAt) {
          return { authenticated: false, paymentId: '', mode: 'per-request', currency: 'sat' }
        }
      }

      // Decode charge request to extract payment hash
      let chargeRequest: LightningChargeRequest
      try {
        chargeRequest = JSON.parse(Buffer.from(challenge.request, 'base64url').toString())
      } catch {
        return { authenticated: false, paymentId: '', mode: 'per-request', currency: 'sat' }
      }

      const paymentHash = chargeRequest.methodDetails?.paymentHash
      if (!paymentHash || !/^[0-9a-f]{64}$/i.test(paymentHash)) {
        return { authenticated: false, paymentId: '', mode: 'per-request', currency: 'sat' }
      }

      // Validate preimage: SHA256(preimage) must equal paymentHash
      const payload = credential.payload as unknown as LightningChargePayload
      if (!payload?.preimage || !/^[0-9a-f]{64}$/i.test(payload.preimage)) {
        return { authenticated: false, paymentId: paymentHash, mode: 'per-request', currency: 'sat' }
      }

      const computed = createHash('sha256')
        .update(Buffer.from(payload.preimage, 'hex'))
        .digest()
      const expected = Buffer.from(paymentHash, 'hex')
      if (!timingSafeEqual(computed, expected)) {
        return { authenticated: false, paymentId: paymentHash, mode: 'per-request', currency: 'sat' }
      }

      return {
        authenticated: true,
        paymentId: paymentHash,
        mode: 'per-request',
        currency: 'sat',
      }
    },
  }
}
