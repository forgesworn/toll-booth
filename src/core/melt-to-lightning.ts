import { Wallet } from '@cashu/cashu-ts'
import type { Proof } from '@cashu/cashu-ts'

export type MeltResult =
  | { paid: true; amountSats: number; preimage?: string }
  | { paid: false; error: string }

/**
 * Melts Cashu proofs to pay a Lightning invoice on the operator's node.
 * Handles the full flow: invoice creation → melt quote → coin selection → melt.
 * Discards change proofs (fee overpayment donated to mint).
 *
 * @param opts.mintUrl - The mint that issued the proofs
 * @param opts.proofs - Server-side proofs from wallet.receive()
 * @param opts.createInvoice - Callback to create a BOLT11 invoice on the operator's node
 */
export async function meltToLightning(opts: {
  mintUrl: string
  proofs: Proof[]
  createInvoice: (amountSats: number) => Promise<string>
}): Promise<MeltResult> {
  const { mintUrl, proofs, createInvoice } = opts

  const totalSats = proofs.reduce((sum, p) => sum + p.amount, 0)
  if (totalSats <= 0) {
    return { paid: false, error: 'No proofs to melt' }
  }

  const wallet = new Wallet(mintUrl, { unit: 'sat' })

  // Create invoice for the full proof amount
  const invoice = await createInvoice(totalSats)

  // Get melt quote to learn fee_reserve
  const meltQuote = await wallet.createMeltQuoteBolt11(invoice)
  const needed = meltQuote.amount + meltQuote.fee_reserve

  if (needed > totalSats) {
    return {
      paid: false,
      error: `Proofs insufficient for fees (have ${totalSats}, need ${needed} including ${meltQuote.fee_reserve} fee reserve)`,
    }
  }

  // Coin selection
  const { send } = await wallet.send(needed, proofs, { includeFees: true })

  // Melt — pay the Lightning invoice via the mint
  const meltResponse = await wallet.meltProofsBolt11(meltQuote, send)

  if (meltResponse.quote.state === 'PAID') {
    // Discard change proofs (keep + change) — bearer instruments not retained
    return {
      paid: true,
      amountSats: meltQuote.amount,
      preimage: meltResponse.quote.payment_preimage ?? undefined,
    }
  }

  return { paid: false, error: `Melt state: ${meltResponse.quote.state}` }
}
