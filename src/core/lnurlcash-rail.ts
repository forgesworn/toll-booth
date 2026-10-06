// src/core/lnurlcash-rail.ts
//
// LNURLcash (LUD-25) payment rail: the caller presents a bearer note URL in
// an `X-LNURLcash` header and the server settles it with one rotate at the
// mint. The rotate is the whole story: it proves the note is live, transfers
// ownership to this server, and burns the presented secret, so a replayed
// note fails at the mint rather than at a local replay table.

import { createHash, randomBytes } from 'node:crypto'
import { hashK1, serverOf } from '@lnurlcash/kit'
import {
  RotateError,
  lookupNote,
  noteCertificate,
  noteUrlWith,
  requireK1,
  resolveNoteInput,
  rotateNote,
  verifyCertificate,
} from './lnurlcash-compat.js'
import type { TollBoothRequest } from './types.js'
import type { PaymentRail, PriceInfo, ChallengeFragment, RailVerifyResult } from './payment-rail.js'
import { canonicalJSON, encodeJCS } from './ietf-payment.js'
import type { LnurlcashRailConfig } from '../types.js'
import type { StorageBackend } from '../storage/interface.js'

const FAIL: RailVerifyResult = { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }

/** Prefix for an LNURLcash payment request, mirroring NUT-18's `creqA`. */
export const LNURLCASH_REQUEST_PREFIX = 'lnurlcashreq1'

/**
 * The request object a challenge names, in the one shape that prefix means.
 *
 * There was briefly a second, shorter shape under the same prefix, with the
 * amount as a NUMBER and no version or id. Two schemas under one prefix
 * cannot both be right, and this is the one the conformance vectors pin and
 * the one the published JSON Schemas validate, which actively reject a
 * numeric amount. So this is what goes out.
 *
 * `id` is a handle on the charge, not a nonce: nothing verifies it coming
 * back, since a payment is identified by the note it burns. It is derived
 * rather than drawn at random so the same charge always names itself the
 * same way, and derived from the SHORT form's canonical bytes so that it
 * agrees with the id a short-form request is given when it is read.
 */
export function buildLnurlcashCharge(
  amountSats: number,
  unit: 'sat',
  mints: string[],
): Record<string, unknown> {
  return {
    amount: String(amountSats),
    currency: unit,
    methodDetails: { mints },
  }
}

/**
 * The same charge as a payment request: what the header carries.
 *
 * A payment request is self-describing, so it adds the two things a bare
 * charge has no room for. `v` says which schema this is. `id` is a handle
 * on the charge, not a nonce, since nothing verifies it coming back: a
 * payment is identified by the note it burns. It is derived rather than
 * drawn at random so the same charge always names itself the same way, and
 * derived from the SHORT form's canonical bytes so it agrees with the id a
 * short-form request is given when it is read.
 */
export function buildLnurlcashRequest(
  amountSats: number,
  unit: 'sat',
  mints: string[],
): Record<string, unknown> {
  const id = createHash('sha256')
    .update(canonicalJSON({ a: amountSats, u: unit, m: mints }))
    .digest('hex')
    .slice(0, 16)
  return { v: 1, id, ...buildLnurlcashCharge(amountSats, unit, mints) }
}

/**
 * Encode a payment request for the `X-LNURLcash` challenge header:
 * `lnurlcashreq1` + base64url(JCS JSON).
 *
 * Defined here rather than taken from a library: @lnurlcash/kit treats
 * payment requests as wallet policy and does not export an encoder.
 */
export function encodeLnurlcashRequest(amountSats: number, unit: 'sat', mints: string[]): string {
  return LNURLCASH_REQUEST_PREFIX + encodeJCS(buildLnurlcashRequest(amountSats, unit, mints))
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
  // a wallet's usual 30s would hold a caller open far too long.
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
      // Two carriers, each in its own settled shape, describing one charge.
      // The body is the charge request the published JSON Schema for this
      // method validates, which forbids anything beyond amount, currency and
      // methodDetails. The header is that same charge as a payment request,
      // which is what `lnurlcashreq1` means and what wallets decode,
      // so it also carries the version and the handle a bare charge has no
      // room for.
      return {
        headers: {
          'X-LNURLcash':
            LNURLCASH_REQUEST_PREFIX + encodeJCS(buildLnurlcashRequest(price.sats!, unit, hosts)),
        },
        body: { lnurlcash: buildLnurlcashCharge(price.sats!, unit, hosts) },
      }
    },

    async verify(req: TollBoothRequest, price?: PriceInfo): Promise<RailVerifyResult> {
      const header = req.headers['x-lnurlcash']
      if (typeof header !== 'string') return FAIL

      // A note is a URL carrying a spend: a 32-byte hex secret, or a
      // key-path or script-path spend, which the mint judges. Anything else,
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

      // Fire-and-forget: hand the operator a note this booth now owns.
      const handOver = (k1: string, amountMsat: number, certificate?: string): void => {
        if (!config.onNoteReceived) return
        try {
          const result = config.onNoteReceived({
            url: noteUrlWith(noteUrl, k1, amountMsat, certificate),
            k1,
            amountMsat,
            host: serverOf(noteUrl),
          })
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch(() => {})
          }
        } catch {
          // Callback errors never block the payment flow.
        }
      }

      let noteMsat: number | undefined
      try {
        const k1 = requireK1(noteUrl)

        // The mint is the authority on what the note is worth, not the
        // `amount` the URL happens to declare. Asked by the note's own k1,
        // the lookup every mint generation answers.
        const info = await lookupNote(noteUrl, clientOptions)
        noteMsat = info.maxWithdrawable

        if (config.requireSignature) {
          // The certificate the payer's note carries, as `c` or the older
          // `sig`, checked under the rule for its shape. A superseded shape
          // with no offline rule proves nothing either way; the mint's own
          // answer (this lookup, and the rotate below) then stands, so an
          // old certificate is never the reason a live note is refused.
          const certificate = noteCertificate(noteUrl)
          if (!certificate || !info.mintPubkey) return FAIL
          if (verifyCertificate(k1, info.maxWithdrawable, certificate, info.mintPubkey) === 'invalid') return FAIL
        }

        if (info.maxWithdrawable < requiredSats * 1000) return FAIL

        // Settlement. The mint generates nothing: the replacement secret is
        // made here and only its hash goes on the wire, so this server is the
        // sole holder of the new note. A spent note fails on this call.
        const rotated = await rotateNote(info.callback, k1, clientOptions)

        // What the mint certified the new note as, kept only if it holds up.
        const verdict =
          rotated.certificate && info.mintPubkey
            ? verifyCertificate(rotated.k1, info.maxWithdrawable, rotated.certificate, info.mintPubkey)
            : undefined
        const certificate = rotated.certificate && verdict !== 'invalid' ? rotated.certificate : undefined

        if (config.requireSignature && verdict !== 'valid') {
          // The rotate landed, so the caller's value now sits under a secret
          // only this booth holds, but the new note cannot be verified
          // offline. Access is refused; the note is handed over to reconcile.
          handOver(rotated.k1, info.maxWithdrawable, certificate)
          return FAIL
        }

        // The new secret is unique per settlement, so its hash is a payment
        // id that can never collide with an earlier one.
        const paymentId = hashK1(rotated.k1)
        const creditedSats = Math.floor(info.maxWithdrawable / 1000)
        if (creditedSats <= 0) return FAIL

        if (storage && !storage.isSettled(paymentId)) {
          storage.settleWithCredit(paymentId, creditedSats, randomBytes(32).toString('hex'), unit)
        }

        handOver(rotated.k1, info.maxWithdrawable, certificate)

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
        logSettlementFailure(error instanceof RotateError ? error.cause : error)
        // A rotate that may have landed still moved the caller's value under
        // a secret only this booth holds. Dropping it would destroy that
        // value, so the operator gets it to reconcile.
        if (noteMsat !== undefined && error instanceof RotateError && error.newK1) {
          handOver(error.newK1, noteMsat)
        }
        return FAIL
      }
    },
  }
}
