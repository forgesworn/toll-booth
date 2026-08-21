// src/core/lnurlcash-rail.ts
//
// LNURLcash (LUD-25) payment rail: the caller presents a bearer note URL in
// an `X-LNURLcash` header and the server settles it with one rotate at the
// mint. The rotate is the whole story: it proves the note is live, transfers
// ownership to this server, and burns the presented secret, so a replayed
// note fails at the mint rather than at a local replay table.

import { randomBytes } from 'node:crypto'
import {
  fetchNoteInfo,
  hashK1,
  noteSignature,
  requireNoteK1,
  resolveNoteInput,
  rotateNote,
  serverOf,
  verifyNoteSignature,
  withNewK1,
} from 'lnurlcash-kit'
import type { TollBoothRequest } from './types.js'
import type { PaymentRail, PriceInfo, ChallengeFragment, RailVerifyResult } from './payment-rail.js'
import { encodeJCS } from './ietf-payment.js'
import type { LnurlcashRailConfig } from '../types.js'
import type { StorageBackend } from '../storage/interface.js'

const FAIL: RailVerifyResult = { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }

/** Prefix for an LNURLcash payment request, mirroring NUT-18's `creqA`. */
export const LNURLCASH_REQUEST_PREFIX = 'lnurlcashreq1'

/**
 * Encode a payment request for the `X-LNURLcash` challenge header:
 * `lnurlcashreq1` + base64url(JCS JSON). Deliberately the same shape the
 * kit's request encoder will produce, so moving to it is not a wire change.
 */
export function encodeLnurlcashRequest(amountSats: number, unit: 'sat', mints: string[]): string {
  return LNURLCASH_REQUEST_PREFIX + encodeJCS({ a: amountSats, u: unit, m: mints })
}

/**
 * Log the class of a settlement failure so an operator can tell "the mint is
 * down" from "that note was already spent". Off unless TOLL_BOOTH_DEBUG is
 * set: never logs the note URL or any secret, only the error class and message.
 */
function logSettlementFailure(error: unknown): void {
  if (!process.env.TOLL_BOOTH_DEBUG) return
  const name = error instanceof Error ? error.constructor.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  console.debug(`[lnurlcash] note refused: ${name}: ${message}`)
}

/**
 * Normalise a configured mint to a bare host. Accepts a host
 * (`mint.example.com`, `127.0.0.1:8899`) or any URL on that host.
 */
function toHost(mint: string): string {
  return serverOf(mint.trim().replace(/^[a-z]+:\/\//i, 'https://')).toLowerCase()
}

export function createLnurlcashRail(config: LnurlcashRailConfig, storage?: StorageBackend): PaymentRail {
  const unit = config.unit ?? 'sat'
  const hosts = config.mints.map(toHost)
  const accepted = new Set(hosts)
  // A paywall verifies on the request path, so the mint gets a short leash:
  // the kit's own default is 30s, which would hold a caller open far too long.
  const clientOptions = { timeoutMs: config.timeoutMs ?? 10_000 }

  return {
    type: 'lnurlcash',
    creditSupported: true,

    canChallenge(price: PriceInfo): boolean {
      return price.sats !== undefined
    },

    detect(req: TollBoothRequest): boolean {
      const header = req.headers['x-lnurlcash']
      return typeof header === 'string' && resolveNoteInput(header) !== null
    },

    async challenge(_route: string, price: PriceInfo): Promise<ChallengeFragment> {
      const amount = price.sats!
      return {
        headers: { 'X-LNURLcash': encodeLnurlcashRequest(amount, unit, hosts) },
        body: {
          lnurlcash: { amount, unit, mints: hosts },
        },
      }
    },

    async verify(req: TollBoothRequest, price?: PriceInfo): Promise<RailVerifyResult> {
      const header = req.headers['x-lnurlcash']
      if (typeof header !== 'string') return FAIL

      // A note is a URL carrying a 32-byte hex secret; anything else,
      // including a payment request echoed back, is not one.
      const noteUrl = resolveNoteInput(header)
      if (!noteUrl) return FAIL

      // Only notes issued by a mint this booth accepts. Checked before any
      // network call, so an unknown host cannot be used to make the server
      // fetch arbitrary URLs.
      if (!accepted.has(serverOf(noteUrl).toLowerCase())) return FAIL

      // A route with no price in sats cannot be paid with a sat-denominated
      // note. Never fall back to zero.
      const requiredSats = price?.sats
      if (requiredSats === undefined) return FAIL

      try {
        const k1 = requireNoteK1(noteUrl)

        // The mint is the authority on what the note is worth, not the
        // `amount` the URL happens to declare.
        const info = await fetchNoteInfo(noteUrl, clientOptions)

        if (config.requireSignature) {
          const signature = noteSignature(noteUrl)
          if (!signature || !info.mintPubkey) return FAIL
          if (!verifyNoteSignature(k1, info.maxWithdrawable, signature, info.mintPubkey)) return FAIL
        }

        if (info.maxWithdrawable < requiredSats * 1000) return FAIL

        // Settlement. The mint generates nothing: the replacement secret is
        // made here and only its hash goes on the wire, so this server is the
        // sole holder of the new note. A spent note fails on this call.
        const rotated = await rotateNote(info.callback, k1, clientOptions)
        const newUrl = withNewK1(noteUrl, rotated.k1, info.maxWithdrawable, rotated.signature)

        // The new secret is unique per settlement, so its hash is a payment
        // id that can never collide with an earlier one.
        const paymentId = hashK1(rotated.k1)
        const creditedSats = Math.floor(info.maxWithdrawable / 1000)
        if (creditedSats <= 0) return FAIL

        if (storage && !storage.isSettled(paymentId)) {
          storage.settleWithCredit(paymentId, creditedSats, randomBytes(32).toString('hex'), unit)
        }

        // Fire-and-forget: hand the operator the note this booth now owns.
        if (config.onNoteReceived) {
          try {
            const result = config.onNoteReceived({
              url: newUrl,
              k1: rotated.k1,
              amountMsat: info.maxWithdrawable,
              host: serverOf(noteUrl),
            })
            if (result && typeof (result as Promise<void>).catch === 'function') {
              (result as Promise<void>).catch(() => {})
            }
          } catch {
            // Callback errors never block the payment flow.
          }
        }

        return {
          authenticated: true,
          paymentId,
          mode: 'credit',
          currency: unit,
          creditBalance: creditedSats,
        }
      } catch (error) {
        // Mint unreachable, note already spent, note unknown, or an
        // ambiguous rotate. All of them fail closed: no access is granted.
        logSettlementFailure(error)
        return FAIL
      }
    },
  }
}
