import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createMockMint } from 'lnurlcash-conformance/mock-mint'
import type { MockMint } from 'lnurlcash-conformance/mock-mint'
import { randomBytes } from 'node:crypto'
import { meltNoteToLightning } from './melt-note-to-lightning.js'

function newSecret(): string {
  return randomBytes(32).toString('hex')
}

function fundedNote(mint: MockMint, amountMsat: number): { url: string; k1: string } {
  const k1 = newSecret()
  mint.state.creditNote(k1, amountMsat)
  return { url: `${mint.url}/w?k1=${k1}&amount=${amountMsat}`, k1 }
}

/** Stands in for the operator's node: records what was asked for. */
function invoicer(): { create: (amountSats: number) => Promise<string>; asked: number[] } {
  const asked: number[] = []
  return {
    asked,
    create: async (amountSats: number) => {
      asked.push(amountSats)
      return `lnbc${amountSats}n1fakeinvoice`
    },
  }
}

describe('meltNoteToLightning', () => {
  let mint: MockMint

  beforeAll(async () => {
    mint = await createMockMint()
  })

  afterAll(async () => {
    await mint.close()
  })

  it('melts a note into an invoice on the operator node', async () => {
    const node = invoicer()
    const { url } = fundedNote(mint, 21_000)

    const result = await meltNoteToLightning({ noteUrl: url, createInvoice: node.create })

    expect(result).toMatchObject({ accepted: true, amountSats: 21 })
    expect(node.asked).toEqual([21])
    if (result.accepted) expect(result.verifyUrl).toContain('/verify/')
  })

  it('asks for the whole-sat floor of a note that is not a whole sat', async () => {
    const node = invoicer()
    const { url } = fundedNote(mint, 21_500)

    const result = await meltNoteToLightning({ noteUrl: url, createInvoice: node.create })

    expect(result).toMatchObject({ accepted: true, amountSats: 21 })
    expect(node.asked).toEqual([21])
  })

  it('accepts the LUD-17 spelling of a note', async () => {
    const node = invoicer()
    const { k1 } = fundedNote(mint, 21_000)
    const lud17 = `lnurlw://127.0.0.1:${mint.port}/w?k1=${k1}&amount=21000`

    const result = await meltNoteToLightning({ noteUrl: lud17, createInvoice: node.create })

    expect(result).toMatchObject({ accepted: true, amountSats: 21 })
  })

  it('refuses anything that is not a bearer note', async () => {
    const node = invoicer()
    const result = await meltNoteToLightning({ noteUrl: 'not-a-note', createInvoice: node.create })
    expect(result).toEqual({ accepted: false, error: 'Not a bearer note URL' })
    expect(node.asked).toEqual([])
  })

  it('refuses a note the mint does not know, without creating an invoice', async () => {
    const node = invoicer()
    const unknown = `${mint.url}/w?k1=${newSecret()}&amount=21000`

    const result = await meltNoteToLightning({ noteUrl: unknown, createInvoice: node.create })

    expect(result.accepted).toBe(false)
    expect(node.asked).toEqual([])
  })

  it('refuses a note worth less than a sat, without creating an invoice', async () => {
    const node = invoicer()
    const { url } = fundedNote(mint, 500)

    const result = await meltNoteToLightning({ noteUrl: url, createInvoice: node.create })

    expect(result).toEqual({ accepted: false, error: 'Note is worth less than a sat' })
    expect(node.asked).toEqual([])
  })

  it('reports a refused melt rather than throwing', async () => {
    const sunset = await createMockMint({ sunset: true })
    try {
      const node = invoicer()
      const { url } = fundedNote(sunset, 21_000)
      // A pending note is one the mint will not spend twice.
      await meltNoteToLightning({ noteUrl: url, createInvoice: node.create })
      const second = await meltNoteToLightning({ noteUrl: url, createInvoice: node.create })
      expect(second.accepted).toBe(false)
    } finally {
      await sunset.close()
    }
  })

  it('reports an unreachable mint rather than throwing', async () => {
    const closed = await createMockMint()
    const { url } = fundedNote(closed, 21_000)
    await closed.close()

    const result = await meltNoteToLightning({ noteUrl: url, createInvoice: invoicer().create })

    expect(result.accepted).toBe(false)
    if (!result.accepted) expect(result.error).toContain('Mint refused the note')
  })

  it('honours the timeout when the mint is slow', async () => {
    const slow = await createMockMint({ slowMs: 500 })
    try {
      const { url } = fundedNote(slow, 21_000)
      const createInvoice = vi.fn()
      const result = await meltNoteToLightning({ noteUrl: url, createInvoice, timeoutMs: 50 })
      expect(result.accepted).toBe(false)
      expect(createInvoice).not.toHaveBeenCalled()
    } finally {
      await slow.close()
    }
  })
})
