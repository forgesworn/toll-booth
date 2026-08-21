// src/core/melt-note-to-lightning.ts
//
// Sweep a LUD-25 bearer note the booth has taken as payment onto the
// operator's own Lightning node. The mirror of melt-to-lightning.ts for the
// lnurlcash rail: pair it with `onNoteReceived` and the booth keeps nothing
// bearer for longer than one payment.

import { fetchNoteInfo, meltNote, requireNoteK1, resolveNoteInput } from 'lnurlcash-kit'

export type MeltNoteResult =
  | { accepted: true; amountSats: number; verifyUrl?: string }
  | { accepted: false; error: string }

/**
 * Melt a note into an invoice on the operator's node.
 *
 * The whole note is spent, so the invoice is created for the note's value
 * rounded down to a whole sat (what a mint accepts, and what a Lightning
 * backend can express). The mint answers as soon as the payment is in
 * flight: `accepted` means the melt was taken, not that it has settled.
 * When the mint supports LUD-21 the result carries a `verifyUrl` to poll:
 * the note is only burned once the outgoing payment actually lands, and a
 * failed payment restores it.
 *
 * @param opts.noteUrl - The note to spend, as `lnurlw://...` or `https://...?k1=...`
 * @param opts.createInvoice - Callback creating a BOLT11 invoice on the operator's node
 * @param opts.timeoutMs - Per-request timeout for calls to the mint. Default 30000.
 */
export async function meltNoteToLightning(opts: {
  noteUrl: string
  createInvoice: (amountSats: number) => Promise<string>
  timeoutMs?: number
}): Promise<MeltNoteResult> {
  const { createInvoice } = opts
  const options = { timeoutMs: opts.timeoutMs ?? 30_000 }

  const noteUrl = resolveNoteInput(opts.noteUrl)
  if (!noteUrl) return { accepted: false, error: 'Not a bearer note URL' }

  let k1: string
  try {
    k1 = requireNoteK1(noteUrl)
  } catch {
    return { accepted: false, error: 'Note carries no secret' }
  }

  let callback: string
  let amountMsat: number
  try {
    const info = await fetchNoteInfo(noteUrl, options)
    callback = info.callback
    amountMsat = info.maxWithdrawable
  } catch (error) {
    return { accepted: false, error: `Mint refused the note: ${(error as Error).message}` }
  }

  const amountSats = Math.floor(amountMsat / 1000)
  if (amountSats <= 0) return { accepted: false, error: 'Note is worth less than a sat' }

  const invoice = await createInvoice(amountSats)

  try {
    const result = await meltNote(callback, k1, invoice, options)
    return { accepted: true, amountSats, ...(result.verify && { verifyUrl: result.verify }) }
  } catch (error) {
    return { accepted: false, error: `Melt refused: ${(error as Error).message}` }
  }
}
