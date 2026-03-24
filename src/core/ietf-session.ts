// src/core/ietf-session.ts
//
// IETF Payment session intent (deposit/bearer/top-up/close lifecycle).
// Implements the session intent from forgesworn/payment-methods alongside
// the existing charge intent in ietf-payment.ts.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { StorageBackend, Session } from '../storage/interface.js'
import type { LightningBackend, SessionConfig } from '../types.js'
import type { PaymentRail, PriceInfo, ChallengeFragment, RailVerifyResult } from './payment-rail.js'
import type { TollBoothRequest } from './types.js'
import {
  computeChallengeId,
  verifyChallengeId,
  encodeJCS,
} from './ietf-payment.js'
import type { IETFChallengeParams, IETFCredential } from './ietf-payment.js'

// --- BOLT11 amount parsing ---

/**
 * Extract the amount in satoshis from a BOLT11 invoice.
 * Returns undefined for amountless invoices.
 * Only parses the human-readable prefix — no full BOLT11 decode needed.
 */
function parseBolt11AmountSats(bolt11: string): number | undefined {
  // BOLT11 format: ln + network + amount + separator
  // Amount is digits + optional multiplier: m=milli, u=micro, n=nano, p=pico
  const match = bolt11.match(/^ln[a-z]*?(\d+)([munp]?)1/)
  if (!match) return undefined
  const num = parseInt(match[1], 10)
  const multiplier = match[2]
  // Base unit is BTC. Convert to satoshis (1 BTC = 100,000,000 sats)
  const btcToSats = 100_000_000
  switch (multiplier) {
    case 'm': return Math.round(num * btcToSats / 1000)       // milli-BTC
    case 'u': return Math.round(num * btcToSats / 1_000_000)  // micro-BTC
    case 'n': return Math.round(num * btcToSats / 1_000_000_000) // nano-BTC
    case 'p': return Math.round(num * btcToSats / 1_000_000_000_000) // pico-BTC
    case '':  return Math.round(num * btcToSats)               // full BTC
    default:  return undefined
  }
}

// --- Session-specific types ---

/** Session challenge request (embedded in challenge `request` param). */
export interface SessionChallengeRequest {
  method: string
  intent: string
  action: string
  deposit: {
    amount: string
    currency: string
    invoice: string
    paymentHash: string
    network: string
  }
  ttl: number
  returnInvoiceRequired: boolean
}

/** Session open payload (in credential `payload`). */
export interface SessionOpenPayload {
  action: 'open'
  preimage: string
  returnInvoice?: string
}

/** Session bearer payload (in credential `payload`). */
export interface SessionBearerPayload {
  action: 'bearer'
  sessionToken: string
}

/** Session top-up payload (in credential `payload`). */
export interface SessionTopUpPayload {
  action: 'topup'
  sessionToken: string
  preimage: string
}

/** Session close payload (in credential `payload`). */
export interface SessionClosePayload {
  action: 'close'
  sessionToken: string
  returnInvoice?: string
}

type SessionPayload =
  | SessionOpenPayload
  | SessionBearerPayload
  | SessionTopUpPayload
  | SessionClosePayload

// --- Session rail config ---

export interface IETFSessionRailConfig {
  /** 64-char hex secret for HMAC challenge binding (same as charge rail). */
  hmacSecret: string
  /** Protection space (e.g. 'api.example.com'). */
  realm: string
  /** Lightning backend for invoice creation and refund payments. */
  backend: LightningBackend
  /** Storage backend for session persistence. */
  storage: StorageBackend
  /** Session configuration with compliance guardrails. */
  session: SessionConfig
  /** Human-readable service description for challenges. */
  description?: string
  /** Human-readable service name for invoice memos. */
  serviceName?: string
  /** Callback fired on session events (open, close, expire). */
  onSessionEvent?: (event: SessionEvent) => void
}

export interface SessionEvent {
  type: 'open' | 'close' | 'expire' | 'topup' | 'deduct'
  sessionId: string
  paymentHash: string
  amountSats?: number
  balanceSats?: number
  refundPreimage?: string
  timestamp: string
}

// --- Defaults ---

const DEFAULT_MAX_DURATION_MS = 86_400_000    // 24 hours
const DEFAULT_MAX_DEPOSIT_SATS = 100_000      // ~$30 USD
const DEFAULT_PRUNE_INTERVAL_MS = 3_600_000   // 1 hour
const DEFAULT_CHALLENGE_EXPIRY_SECS = 900     // 15 minutes

// --- Session rail factory ---

export function createIETFSessionRail(config: IETFSessionRailConfig): PaymentRail & {
  /** Start the auto-close sweep for expired sessions. Returns a stop function. */
  startSweep(): () => void
  /** Manually sweep expired sessions (useful for testing). */
  sweepExpired(): Promise<number>
  /** Get a session by bearer token (for NeedTopUp checks in streaming). */
  getSessionByBearer(token: string): Session | null
} {
  const { hmacSecret, realm, backend, storage, description } = config
  if (!backend.sendPayment) {
    throw new Error('Session intent requires a Lightning backend that supports sendPayment() for refunds')
  }
  const label = config.serviceName ?? 'toll-booth'
  const maxDurationMs = config.session.maxSessionDurationMs ?? DEFAULT_MAX_DURATION_MS
  const maxDepositSats = config.session.maxDepositSats ?? DEFAULT_MAX_DEPOSIT_SATS
  const pruneIntervalMs = config.session.sessionPruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS

  function emitEvent(event: SessionEvent) {
    config.onSessionEvent?.(event)
  }

  /** Sweep expired sessions: auto-close and attempt refund. */
  async function sweepExpired(): Promise<number> {
    const expired = storage.getExpiredSessions()
    let count = 0
    for (const session of expired) {
      try {
        await refundAndClose(session)
        count++
      } catch (err) {
        // Emit event so operators can observe stuck sessions
        emitEvent({
          type: 'expire',
          sessionId: session.sessionId,
          paymentHash: session.paymentHash,
          amountSats: session.balanceSats,
          balanceSats: session.balanceSats,
          timestamp: new Date().toISOString(),
        })
      }
    }
    // Also prune long-closed sessions
    storage.pruneClosedSessions(maxDurationMs)
    return count
  }

  /**
   * Refund remaining balance and close a session.
   * Uses atomic close-before-pay to prevent TOCTOU double-refund:
   * the session is marked closed BEFORE the payment is sent.
   */
  async function refundAndClose(session: Session): Promise<string | undefined> {
    // TOCTOU protection: close the session first, then attempt refund.
    // This prevents concurrent close + sweep from both sending payments.
    storage.closeSession(session.sessionId)

    let refundPreimage: string | undefined
    if (session.balanceSats > 0 && session.returnInvoice && backend.sendPayment) {
      // Validate return invoice amount matches remaining balance
      const invoiceAmountSats = parseBolt11AmountSats(session.returnInvoice)
      if (invoiceAmountSats !== undefined && invoiceAmountSats !== session.balanceSats) {
        // Amount mismatch — do not pay. Session is already closed.
        emitEvent({
          type: 'expire',
          sessionId: session.sessionId,
          paymentHash: session.paymentHash,
          amountSats: session.balanceSats,
          balanceSats: 0,
          timestamp: new Date().toISOString(),
        })
        return undefined
      }
      const result = await backend.sendPayment(session.returnInvoice)
      refundPreimage = result.preimage
      // Update the closed session with the refund preimage
      storage.closeSession(session.sessionId, refundPreimage)
    }

    emitEvent({
      type: session.balanceSats > 0 ? 'close' : 'expire',
      sessionId: session.sessionId,
      paymentHash: session.paymentHash,
      amountSats: session.balanceSats,
      balanceSats: 0,
      refundPreimage,
      timestamp: new Date().toISOString(),
    })
    return refundPreimage
  }

  return {
    type: 'ietf-session',
    creditSupported: true,

    canChallenge(price: PriceInfo): boolean {
      return price.sats !== undefined
    },

    detect(req: TollBoothRequest): boolean {
      const auth = req.headers.authorization ?? req.headers.Authorization ?? ''
      if (!/^Payment\s/i.test(auth)) return false
      // Distinguish session from charge: check if payload has session action
      const token = auth.replace(/^Payment\s+/i, '')
      try {
        const decoded = JSON.parse(Buffer.from(token, 'base64url').toString())
        const action = decoded?.payload?.action
        return action === 'bearer' || action === 'open' || action === 'topup' || action === 'close'
      } catch {
        return false
      }
    },

    async challenge(route: string, price: PriceInfo): Promise<ChallengeFragment> {
      const depositSats = Math.min(price.sats!, maxDepositSats)
      const invoice = await backend.createInvoice(depositSats, `${label}: session deposit for ${route}`)

      const ttlSecs = Math.floor(maxDurationMs / 1000)
      const sessionRequest: SessionChallengeRequest = {
        method: 'lightning',
        intent: 'session',
        action: 'challenge',
        deposit: {
          amount: String(depositSats),
          currency: 'sat',
          invoice: invoice.bolt11,
          paymentHash: invoice.paymentHash,
          network: 'mainnet',
        },
        ttl: ttlSecs,
        returnInvoiceRequired: true,
      }

      const requestEncoded = encodeJCS(sessionRequest as unknown as Record<string, unknown>)
      const expires = new Date(Date.now() + DEFAULT_CHALLENGE_EXPIRY_SECS * 1000).toISOString()

      const challengeParams: IETFChallengeParams = {
        realm,
        method: 'lightning',
        intent: 'session',
        request: requestEncoded,
        expires,
        ...(description && { description }),
      }

      const id = computeChallengeId(hmacSecret, challengeParams)

      const parts = [
        `id="${id}"`,
        `realm="${realm}"`,
        `method="lightning"`,
        `intent="session"`,
        `request="${requestEncoded}"`,
        `expires="${expires}"`,
      ]
      if (description) parts.push(`description="${description}"`)

      return {
        headers: {
          'WWW-Authenticate': `Payment ${parts.join(', ')}`,
        },
        body: {
          ietf_session: {
            scheme: 'Payment',
            description: 'Deposit-based session (IETF standard, streaming)',
            method: 'lightning',
            intent: 'session',
            payment_hash: invoice.paymentHash,
            deposit_sats: depositSats,
            ttl_seconds: ttlSecs,
          },
        },
      }
    },

    async verify(req: TollBoothRequest): Promise<RailVerifyResult> {
      const auth = req.headers.authorization ?? req.headers.Authorization ?? ''
      const token = auth.replace(/^Payment\s+/i, '')

      let credential: IETFCredential
      try {
        credential = JSON.parse(Buffer.from(token, 'base64url').toString())
      } catch {
        return { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }
      }

      const payload = credential.payload as unknown as SessionPayload
      if (!payload?.action) {
        return { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }
      }

      // --- Bearer auth (most common — used on every request) ---
      if (payload.action === 'bearer') {
        const bearer = payload as SessionBearerPayload
        if (!bearer.sessionToken) {
          return { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }
        }
        const session = storage.getSessionByBearer(bearer.sessionToken)
        if (!session || session.closedAt) {
          return { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }
        }
        // Check session not expired
        if (new Date(session.expiresAt).getTime() < Date.now()) {
          return { authenticated: false, paymentId: session.paymentHash, mode: 'credit', currency: 'sat' }
        }
        return {
          authenticated: true,
          paymentId: session.sessionId,
          mode: 'session',
          creditBalance: session.balanceSats,
          currency: 'sat',
        }
      }

      // --- Open, top-up, close require challenge verification ---
      const challenge = credential.challenge
      if (!challenge?.id || !challenge.realm || !challenge.method || !challenge.intent || !challenge.request) {
        return { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }
      }

      // Verify HMAC binding
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
        return { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }
      }

      // Check challenge expiry
      if (challenge.expires) {
        const expiresAt = new Date(challenge.expires).getTime()
        if (isNaN(expiresAt) || Date.now() > expiresAt) {
          return { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }
        }
      }

      // Decode session request
      let sessionRequest: SessionChallengeRequest
      try {
        sessionRequest = JSON.parse(Buffer.from(challenge.request, 'base64url').toString())
      } catch {
        return { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }
      }

      const paymentHash = sessionRequest.deposit?.paymentHash
      if (!paymentHash || !/^[0-9a-f]{64}$/i.test(paymentHash)) {
        return { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }
      }

      // --- Open: verify deposit preimage, create session ---
      if (payload.action === 'open') {
        const open = payload as SessionOpenPayload
        if (!open.preimage || !/^[0-9a-f]{64}$/i.test(open.preimage)) {
          return { authenticated: false, paymentId: paymentHash, mode: 'credit', currency: 'sat' }
        }

        // Verify preimage
        const computed = createHash('sha256').update(Buffer.from(open.preimage, 'hex')).digest()
        const expected = Buffer.from(paymentHash, 'hex')
        if (!timingSafeEqual(computed, expected)) {
          return { authenticated: false, paymentId: paymentHash, mode: 'credit', currency: 'sat' }
        }

        // Check deposit limit
        const depositSats = parseInt(sessionRequest.deposit.amount, 10)
        if (depositSats > maxDepositSats) {
          return { authenticated: false, paymentId: paymentHash, mode: 'credit', currency: 'sat' }
        }

        // Create session — reject replay of same deposit
        const sessionId = paymentHash // Deterministic: one session per deposit
        const existing = storage.getSession(sessionId)
        if (existing) {
          return { authenticated: false, paymentId: paymentHash, mode: 'credit', currency: 'sat' }
        }

        const bearerToken = randomBytes(32).toString('hex')
        const expiresAt = new Date(Date.now() + maxDurationMs).toISOString()

        storage.createSession({
          sessionId,
          paymentHash,
          balanceSats: depositSats,
          depositSats,
          bearerToken,
          expiresAt,
          returnInvoice: open.returnInvoice,
        })

        emitEvent({
          type: 'open',
          sessionId,
          paymentHash,
          amountSats: depositSats,
          balanceSats: depositSats,
          timestamp: new Date().toISOString(),
        })

        return {
          authenticated: true,
          paymentId: sessionId,
          mode: 'session',
          creditBalance: depositSats,
          currency: 'sat',
          customCaveats: {
            'X-Session-Token': bearerToken,
            'X-Session-Expires': expiresAt,
            'X-Session-Id': sessionId,
          },
        }
      }

      // --- Top-up and close require an existing session ---
      if (payload.action === 'topup') {
        const topup = payload as SessionTopUpPayload
        if (!topup.sessionToken || !topup.preimage) {
          return { authenticated: false, paymentId: paymentHash, mode: 'credit', currency: 'sat' }
        }

        const session = storage.getSessionByBearer(topup.sessionToken)
        if (!session || session.closedAt) {
          return { authenticated: false, paymentId: paymentHash, mode: 'credit', currency: 'sat' }
        }

        // Verify top-up preimage
        const computed = createHash('sha256').update(Buffer.from(topup.preimage, 'hex')).digest()
        const expected = Buffer.from(paymentHash, 'hex')
        if (!timingSafeEqual(computed, expected)) {
          return { authenticated: false, paymentId: paymentHash, mode: 'credit', currency: 'sat' }
        }

        // Check deposit cap
        const topupAmount = parseInt(sessionRequest.deposit.amount, 10)
        if (session.depositSats + topupAmount > maxDepositSats) {
          return { authenticated: false, paymentId: session.sessionId, mode: 'credit', currency: 'sat' }
        }

        const { newBalance } = storage.topUpSession(session.sessionId, topupAmount)

        emitEvent({
          type: 'topup',
          sessionId: session.sessionId,
          paymentHash: session.paymentHash,
          amountSats: topupAmount,
          balanceSats: newBalance,
          timestamp: new Date().toISOString(),
        })

        return {
          authenticated: true,
          paymentId: session.sessionId,
          mode: 'session',
          creditBalance: newBalance,
          currency: 'sat',
        }
      }

      if (payload.action === 'close') {
        const close = payload as SessionClosePayload
        if (!close.sessionToken) {
          return { authenticated: false, paymentId: paymentHash, mode: 'credit', currency: 'sat' }
        }

        const session = storage.getSessionByBearer(close.sessionToken)
        if (!session || session.closedAt) {
          return { authenticated: false, paymentId: paymentHash, mode: 'credit', currency: 'sat' }
        }

        // Refund-to-originator: always use the return invoice from session open.
        // Close-time override is not permitted (prevents refund redirect attacks).
        const returnInvoice = session.returnInvoice

        // Attempt refund if balance > 0 and return invoice exists
        let refundPreimage: string | undefined
        if (session.balanceSats > 0 && returnInvoice && backend.sendPayment) {
          // CRITICAL: validate return invoice amount matches remaining balance.
          // Amountless invoices are always safe; amount-specified invoices must
          // match the remaining balance to prevent operator fund drain.
          const invoiceAmountSats = parseBolt11AmountSats(returnInvoice)
          if (invoiceAmountSats !== undefined && invoiceAmountSats !== session.balanceSats) {
            // Amount mismatch — do not pay. Emit event for operator visibility.
            emitEvent({
              type: 'close',
              sessionId: session.sessionId,
              paymentHash: session.paymentHash,
              amountSats: session.balanceSats,
              balanceSats: 0,
              timestamp: new Date().toISOString(),
            })
            storage.closeSession(session.sessionId)
            return {
              authenticated: true,
              paymentId: session.sessionId,
              mode: 'session',
              creditBalance: 0,
              currency: 'sat',
              customCaveats: {
                'X-Session-Closed': 'true',
                'X-Refund-Status': 'amount-mismatch',
              },
            }
          }
          try {
            const result = await backend.sendPayment(returnInvoice)
            refundPreimage = result.preimage
          } catch {
            // Refund failed — close anyway, operator can handle manually
          }
        }

        storage.closeSession(session.sessionId, refundPreimage)

        emitEvent({
          type: 'close',
          sessionId: session.sessionId,
          paymentHash: session.paymentHash,
          amountSats: session.balanceSats,
          balanceSats: 0,
          refundPreimage,
          timestamp: new Date().toISOString(),
        })

        return {
          authenticated: true,
          paymentId: session.sessionId,
          mode: 'session',
          creditBalance: 0,
          currency: 'sat',
          customCaveats: {
            'X-Session-Closed': 'true',
            ...(refundPreimage && { 'X-Refund-Preimage': refundPreimage }),
          },
        }
      }

      return { authenticated: false, paymentId: '', mode: 'session', currency: 'sat' }
    },

    startSweep(): () => void {
      const timer = setInterval(() => { sweepExpired().catch(() => {}) }, pruneIntervalMs)
      return () => clearInterval(timer)
    },

    sweepExpired,

    getSessionByBearer(token: string): Session | null {
      return storage.getSessionByBearer(token)
    },
  }
}
