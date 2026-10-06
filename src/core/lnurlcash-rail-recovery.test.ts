import { describe, it, expect, afterAll, vi } from 'vitest'
import { createMockMint } from 'lnurlcash-conformance/mock-mint'
import type { MockMint } from 'lnurlcash-conformance/mock-mint'
import { randomBytes } from 'node:crypto'
import { memoryStorage } from '../storage/memory.js'
import type { TollBoothRequest } from './types.js'

// A rotate the mint confirms without a certificate has already spent the
// presented note. Under requireSignature the booth refuses access, but the
// replacement secret is the only key to the caller's value, so the rail must
// hand it on rather than drop it. The rotate here really lands at the mint;
// only the certificate on the way back is withheld.
let withholdCertificate = false

vi.mock('./lnurlcash-compat.js', async (importOriginal) => {
  const compat = await importOriginal<typeof import('./lnurlcash-compat.js')>()
  return {
    ...compat,
    rotateNote: async (...args: Parameters<typeof compat.rotateNote>) => {
      const rotated = await compat.rotateNote(...args)
      return withholdCertificate ? { k1: rotated.k1 } : rotated
    },
  }
})

const { createLnurlcashRail } = await import('./lnurlcash-rail.js')

const mints: MockMint[] = []
afterAll(async () => {
  await Promise.all(mints.map((m) => m.close()))
})

async function mint(options: Parameters<typeof createMockMint>[0] = {}): Promise<MockMint> {
  const m = await createMockMint(options)
  mints.push(m)
  return m
}

function makeReq(headers: Record<string, string>): TollBoothRequest {
  return { method: 'GET', path: '/api/test', headers, ip: '127.0.0.1' }
}

function presented(m: MockMint, amountMsat = 21_000): { url: string; k1: string } {
  const k1 = randomBytes(32).toString('hex')
  const cert = m.state.creditNote(k1, amountMsat)
  const url = new URL(`${m.url}/w`)
  url.searchParams.set('k1', k1)
  if (cert) url.searchParams.set('c', cert)
  else url.searchParams.set('amount', String(amountMsat))
  return { url: url.toString(), k1 }
}

describe('lnurlcash-rail recovery', () => {
  it('refuses access but hands over a note whose rotate landed without a certificate', async () => {
    const m = await mint()
    const { url, k1 } = presented(m)
    const onNoteReceived = vi.fn()
    const rail = createLnurlcashRail(
      { mints: [`127.0.0.1:${m.port}`], requireSignature: true, onNoteReceived },
      memoryStorage(),
    )

    withholdCertificate = true
    try {
      const result = await rail.verify(makeReq({ 'x-lnurlcash': url }), { sats: 10 })
      expect(result.authenticated).toBe(false)
    } finally {
      withholdCertificate = false
    }

    expect(m.state.noteState(k1)).toBe('burned')
    expect(onNoteReceived).toHaveBeenCalledTimes(1)
    const note = onNoteReceived.mock.calls[0][0]
    expect(note.amountMsat).toBe(21_000)
    const held = new URL(note.url)
    expect(held.searchParams.get('k1')).toBe(note.k1)
    expect(held.searchParams.get('amount')).toBe('21000')
    expect(held.searchParams.get('c')).toBeNull()
    expect(held.searchParams.get('sig')).toBeNull()
    // The handed-over note is real: the mint holds it under the new secret.
    expect(m.state.noteState(note.k1)).toBe('outstanding')
  })

  it('refuses access but hands over a note whose rotate the mint did not confirm', async () => {
    const m = await mint({ unconfirmedMutation: true })
    const { url, k1 } = presented(m)
    const onNoteReceived = vi.fn()
    const rail = createLnurlcashRail({ mints: [`127.0.0.1:${m.port}`], onNoteReceived }, memoryStorage())

    const result = await rail.verify(makeReq({ 'x-lnurlcash': url }), { sats: 10 })

    expect(result.authenticated).toBe(false)
    expect(m.state.noteState(k1)).toBe('burned')
    expect(onNoteReceived).toHaveBeenCalledTimes(1)
    const note = onNoteReceived.mock.calls[0][0]
    expect(m.state.noteState(note.k1)).toBe('outstanding')
  })

  it('settles a rotate whose answer was lost, by retrying it and taking the replay', async () => {
    const m = await mint({ dropAfterMutation: true })
    const { url, k1 } = presented(m)
    const onNoteReceived = vi.fn()
    const rail = createLnurlcashRail({ mints: [`127.0.0.1:${m.port}`], onNoteReceived }, memoryStorage())

    const result = await rail.verify(makeReq({ 'x-lnurlcash': url }), { sats: 10 })

    expect(result.authenticated).toBe(true)
    expect(m.state.noteState(k1)).toBe('burned')
    expect(onNoteReceived).toHaveBeenCalledTimes(1)
    expect(m.state.noteState(onNoteReceived.mock.calls[0][0].k1)).toBe('outstanding')
  })

  it('hands nothing over when the mint refuses the rotate outright', async () => {
    const m = await mint()
    const { url, k1 } = presented(m)
    const onNoteReceived = vi.fn()
    const rail = createLnurlcashRail({ mints: [`127.0.0.1:${m.port}`], onNoteReceived }, memoryStorage())

    // Spend it between the lookup and the rotate by spending it first: the
    // lookup then refuses, so nothing is rotated and nothing is handed over.
    const first = await rail.verify(makeReq({ 'x-lnurlcash': url }), { sats: 10 })
    const second = await rail.verify(makeReq({ 'x-lnurlcash': url }), { sats: 10 })

    expect(first.authenticated).toBe(true)
    expect(second.authenticated).toBe(false)
    expect(m.state.noteState(k1)).toBe('burned')
    expect(onNoteReceived).toHaveBeenCalledTimes(1)
  })
})
