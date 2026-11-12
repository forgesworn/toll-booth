// src/core/melt-note-to-lightning.ts
//
// Sweep a LUD-25 bearer note the booth has taken as payment onto the
// operator's own Lightning node. The mirror of melt-to-lightning.ts for the
// lnurlcash rail: pair it with `onNoteReceived` and the booth keeps nothing
// bearer for longer than one payment.

import { tryDecodeBolt11 } from 'farrier-kit/bolt11'
import { lookupNote, meltNote, requireK1, resolveNoteInput } from './lnurlcash-compat.js'

export type MeltNoteResult =
  | {
      accepted: true
      /**
       * The note's value rounded down to a whole sat, which is what the
       * invoice from `createInvoice` was for. Not a receipt: credit what
       * your node records as received for the invoice.
       */
      amountSats: number
      /**
       * The note's exact value, present only when the melt went through
       * `createAmountlessInvoice`. Not a receipt: the mint chooses what it
       * pays into an invoice that states no amount. A mint that follows the
       * current LUD-25 pays this value, but an older mint pays the
       * whole-sat floor, so booking this can over-credit by up to 999 msat.
       * Credit what your node records as received for the invoice.
       */
      amountMsat?: number
      verifyUrl?: string
    }
  | { accepted: false; error: string }

/**
 * Melt a note into an invoice on the operator's node.
 *
 * The whole note is spent. A note worth a whole number of sats is melted
 * into an invoice from `createInvoice` for that value. Mints that follow
 * the current LUD-25 pay only an invoice for the note's exact value, or one
 * that states no amount, which a whole-sat invoice cannot be for a note
 * worth, say, 21500 msat. For such a note, supply `createAmountlessInvoice`:
 * the note is melted into the invoice it returns, which must state no
 * amount (or exactly the note's value), and is checked before it goes to
 * the mint. A current mint then pays the note's exact value, an older one
 * its whole-sat floor. Without that callback such a note is melted, as
 * before, into a `createInvoice` invoice for the whole-sat floor, which
 * older mints accept and current ones refuse. When the mint refuses it for
 * not being the note's exact value, the error says so and names
 * `createAmountlessInvoice`, and the note stays outstanding and spendable;
 * other failures are reported as the mint gave them. Neither `amountSats`
 * nor `amountMsat` is a receipt: credit what your node records as received.
 * The mint answers as soon as the payment is in flight: `accepted` means
 * the melt was taken, not that it has settled.
 * When the mint supports LUD-21 the result carries a `verifyUrl` to poll:
 * the note is only burned once the outgoing payment actually lands, and a
 * failed payment restores it.
 *
 * Any note this booth has handed over can be melted, whichever version of
 * toll-booth wrote it and whichever mint generation issued it: the note is
 * looked up by its own `k1` and melted with `k1` and `pr`, which every mint
 * reads, and any certificate it carries (`c`, or the older `sig`) is left
 * off the wire.
 *
 * @param opts.noteUrl - The note to spend, as `lnurlw://...` or `https://...?k1=...`
 * @param opts.createInvoice - Callback creating a BOLT11 invoice on the operator's node
 * @param opts.createAmountlessInvoice - Optional callback creating a BOLT11 invoice that
 *   states no amount, used only for a note that is not a whole number of sats
 * @param opts.timeoutMs - Per-request timeout for calls to the mint. Default 30000.
 */
export async function meltNoteToLightning(opts: {
  noteUrl: string
  createInvoice: (amountSats: number) => Promise<string>
  createAmountlessInvoice?: () => Promise<string>
  timeoutMs?: number
}): Promise<MeltNoteResult> {
  const { createInvoice, createAmountlessInvoice } = opts
  const options = { timeoutMs: opts.timeoutMs ?? 30_000 }

  const noteUrl = resolveNoteInput(opts.noteUrl)
  if (!noteUrl) return { accepted: false, error: 'Not a bearer note URL' }

  let k1: string
  try {
    k1 = requireK1(noteUrl)
  } catch {
    return { accepted: false, error: 'Note carries no secret' }
  }

  let callback: string
  let amountMsat: number
  try {
    const info = await lookupNote(noteUrl, options)
    callback = info.callback
    amountMsat = info.maxWithdrawable
  } catch (error) {
    return { accepted: false, error: `Mint refused the note: ${(error as Error).message}` }
  }

  const amountSats = Math.floor(amountMsat / 1000)
  const wholeSats = amountMsat % 1000 === 0

  if (!wholeSats && createAmountlessInvoice) {
    const invoice = await createAmountlessInvoice()
    const decoded = tryDecodeBolt11(invoice)
    if (!decoded) {
      return { accepted: false, error: 'createAmountlessInvoice did not return a BOLT11 invoice' }
    }
    if (decoded.amountMsats !== null && decoded.amountMsats !== BigInt(amountMsat)) {
      return {
        accepted: false,
        error:
          `createAmountlessInvoice returned an invoice for ${decoded.amountMsats} msat; ` +
          `it must state no amount, or exactly the note's ${amountMsat} msat`,
      }
    }
    try {
      const result = await meltNote(callback, k1, invoice, options)
      return { accepted: true, amountSats, amountMsat, ...(result.verify && { verifyUrl: result.verify }) }
    } catch (error) {
      return { accepted: false, error: `Melt refused: ${(error as Error).message}` }
    }
  }

  if (amountSats <= 0) return { accepted: false, error: 'Note is worth less than a sat' }

  const invoice = await createInvoice(amountSats)

  try {
    const result = await meltNote(callback, k1, invoice, options)
    return { accepted: true, amountSats, ...(result.verify && { verifyUrl: result.verify }) }
  } catch (error) {
    const message = (error as Error).message
    const refusal = `Melt refused: ${message}`
    // Only the exact-value refusal is explained by the note not being whole
    // sats. A timeout, a spent or pending note, or an unconfirmed melt that
    // may be in flight keeps the mint's own message, unadorned.
    if (wholeSats || !/must be for exactly/i.test(message)) return { accepted: false, error: refusal }
    return {
      accepted: false,
      error:
        `${refusal.replace(/\.$/, '')}. The note is worth ${amountMsat} msat, not a whole number of sats, ` +
        `and mints that follow the current LUD-25 refuse a whole-sat invoice for it. ` +
        `Supply createAmountlessInvoice to melt it into an invoice that states no amount.`,
    }
  }
}
