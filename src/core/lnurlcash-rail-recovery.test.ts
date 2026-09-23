import { describe, it, expect, afterAll, vi } from 'vitest'
import { createMockMint } from 'lnurlcash-conformance/mock-mint'
import { randomBytes } from 'node:crypto'
import { memoryStorage } from '../storage/memory.js'
import type { TollBoothRequest } from './types.js'

// A rotate the mint confirms without a signature has already spent the
// presented note. The kit refuses it but carries the replacement secret, and
// the rail must hand that secret on rather than drop it with the value.
const replacement = randomBytes(32).toString('hex')

vi.mock('lnurlcash-kit', async (importOriginal) => {
  const kit = await importOriginal<typeof import('lnurlcash-kit')>()
  return {
    ...kit,
    rotateNote: async () => {
      throw new kit.UnverifiableNoteError('rotate confirmed without a signature', [replacement])
    },
  }
})

const { createLnurlcashRail } = await import('./lnurlcash-rail.js')

const mint = await createMockMint()
afterAll(() => mint.close())

function makeReq(headers: Record<string, string>): TollBoothRequest {
  return { method: 'GET', path: '/api/test', headers, ip: '127.0.0.1' }
}

describe('lnurlcash-rail recovery', () => {
  it('refuses access but hands over a note whose rotate landed unsigned', async () => {
    const k1 = randomBytes(32).toString('hex')
    const sig = mint.state.creditNote(k1, 21_000)
    const presented = new URL(`${mint.url}/w`)
    presented.searchParams.set('k1', k1)
    presented.searchParams.set('amount', '21000')
    if (sig) presented.searchParams.set('sig', sig)

    const onNoteReceived = vi.fn()
    const rail = createLnurlcashRail(
      { mints: [`127.0.0.1:${mint.port}`], requireSignature: true, onNoteReceived },
      memoryStorage(),
    )
    const result = await rail.verify(makeReq({ 'x-lnurlcash': presented.toString() }), { sats: 10 })

    expect(result.authenticated).toBe(false)
    expect(onNoteReceived).toHaveBeenCalledTimes(1)
    const note = onNoteReceived.mock.calls[0][0]
    expect(note.k1).toBe(replacement)
    expect(note.amountMsat).toBe(21_000)
    expect(new URL(note.url).searchParams.get('k1')).toBe(replacement)
    expect(new URL(note.url).searchParams.get('sig')).toBeNull()
  })
})
