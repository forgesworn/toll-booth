import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createMockMint } from 'lnurlcash-conformance/mock-mint'
import type { MockMint } from 'lnurlcash-conformance/mock-mint'
import { randomBytes } from 'node:crypto'
import { createLnurlcashRail, encodeLnurlcashRequest, LNURLCASH_REQUEST_PREFIX } from './lnurlcash-rail.js'
import { memoryStorage } from '../storage/memory.js'
import type { TollBoothRequest } from './types.js'
import type { LnurlcashRailConfig } from '../types.js'

function makeReq(headers: Record<string, string | undefined> = {}, path = '/api'): TollBoothRequest {
  return { method: 'GET', path, headers, ip: '127.0.0.1' }
}

function newSecret(): string {
  return randomBytes(32).toString('hex')
}

/** A funded note on `mint`, worth `amountMsat`, as a client would present it. */
function fundedNote(mint: MockMint, amountMsat: number): string {
  const k1 = newSecret()
  const sig = mint.state.creditNote(k1, amountMsat)
  const url = new URL(`${mint.url}/w`)
  url.searchParams.set('k1', k1)
  url.searchParams.set('amount', String(amountMsat))
  if (sig) url.searchParams.set('sig', sig)
  return url.toString()
}

describe('lnurlcash-rail', () => {
  let mint: MockMint
  let config: LnurlcashRailConfig

  beforeAll(async () => {
    mint = await createMockMint()
    config = { mints: [`127.0.0.1:${mint.port}`] }
  })

  afterAll(async () => {
    await mint.close()
  })

  describe('type and flags', () => {
    it('has type lnurlcash', () => {
      expect(createLnurlcashRail(config).type).toBe('lnurlcash')
    })

    it('supports credit mode', () => {
      expect(createLnurlcashRail(config).creditSupported).toBe(true)
    })
  })

  describe('canChallenge', () => {
    it('returns true when the price has sats', () => {
      expect(createLnurlcashRail(config).canChallenge!({ sats: 10 })).toBe(true)
    })

    it('returns false when the price is usd only', () => {
      expect(createLnurlcashRail(config).canChallenge!({ usd: 100 })).toBe(false)
    })
  })

  describe('detect', () => {
    it('detects an lnurlw note URL', () => {
      const rail = createLnurlcashRail(config)
      expect(rail.detect(makeReq({ 'x-lnurlcash': `lnurlw://127.0.0.1:${mint.port}/w?k1=${newSecret()}` }))).toBe(true)
    })

    it('detects an https note URL', () => {
      const rail = createLnurlcashRail(config)
      expect(rail.detect(makeReq({ 'x-lnurlcash': `https://mint.example.com/w?k1=${newSecret()}` }))).toBe(true)
    })

    it('does not detect a payment request echoed back', () => {
      const rail = createLnurlcashRail(config)
      const request = encodeLnurlcashRequest(10, 'sat', ['mint.example.com'])
      expect(rail.detect(makeReq({ 'x-lnurlcash': request }))).toBe(false)
    })

    it('does not detect a URL with no secret', () => {
      const rail = createLnurlcashRail(config)
      expect(rail.detect(makeReq({ 'x-lnurlcash': 'https://mint.example.com/w' }))).toBe(false)
    })

    it('does not detect a missing or empty header', () => {
      const rail = createLnurlcashRail(config)
      expect(rail.detect(makeReq())).toBe(false)
      expect(rail.detect(makeReq({ 'x-lnurlcash': '' }))).toBe(false)
    })
  })

  describe('challenge', () => {
    it('returns an X-LNURLcash payment request', async () => {
      const rail = createLnurlcashRail(config)
      const fragment = await rail.challenge('/api', { sats: 10 })
      const header = fragment.headers['X-LNURLcash']
      expect(header.startsWith(LNURLCASH_REQUEST_PREFIX)).toBe(true)

      const decoded = JSON.parse(
        Buffer.from(header.slice(LNURLCASH_REQUEST_PREFIX.length), 'base64url').toString(),
      )
      // The amount is a decimal STRING. The published charge-request schema
      // for this method rejects a numeric one, and the conformance vectors
      // pin the same shape, so this is what the prefix means.
      expect(decoded).toEqual({
        v: 1,
        id: expect.stringMatching(/^[0-9a-f]{16}$/),
        amount: '10',
        currency: 'sat',
        methodDetails: { mints: [`127.0.0.1:${mint.port}`] },
      })
    })

    it('names the same charge the same way every time', async () => {
      const rail = createLnurlcashRail(config)
      const idOf = async (): Promise<string> => {
        const fragment = await rail.challenge('/api', { sats: 10 })
        const header = fragment.headers['X-LNURLcash']
        return JSON.parse(
          Buffer.from(header.slice(LNURLCASH_REQUEST_PREFIX.length), 'base64url').toString(),
        ).id
      }
      expect(await idOf()).toBe(await idOf())
      const other = createLnurlcashRail(config)
      const fragment = await other.challenge('/api', { sats: 11 })
      const id = JSON.parse(
        Buffer.from(
          fragment.headers['X-LNURLcash'].slice(LNURLCASH_REQUEST_PREFIX.length),
          'base64url',
        ).toString(),
      ).id
      expect(id).not.toBe(await idOf())
    })

    it('describes one charge in both carriers, each in its own shape', async () => {
      const rail = createLnurlcashRail(config)
      const fragment = await rail.challenge('/api', { sats: 10 })
      const decoded = JSON.parse(
        Buffer.from(
          fragment.headers['X-LNURLcash'].slice(LNURLCASH_REQUEST_PREFIX.length),
          'base64url',
        ).toString(),
      )
      // The body is the charge request the published schema validates, which
      // admits nothing beyond these three. The header is that same charge as
      // a payment request, so it adds the version and the handle.
      const { v, id, ...charge } = decoded
      expect(v).toBe(1)
      expect(typeof id).toBe('string')
      expect(fragment.body).toEqual({ lnurlcash: charge })
    })

    it('normalises a configured mint URL down to its host', async () => {
      const rail = createLnurlcashRail({ mints: ['https://mint.example.com/.well-known/lnurlw/mint'] })
      const fragment = await rail.challenge('/api', { sats: 10 })
      expect(fragment.body).toMatchObject({
        lnurlcash: { methodDetails: { mints: ['mint.example.com'] } },
      })
    })
  })

  describe('verify', () => {
    it('accepts a funded note and credits its full value', async () => {
      const storage = memoryStorage()
      const rail = createLnurlcashRail(config, storage)
      const note = fundedNote(mint, 21_000)

      const result = await rail.verify(makeReq({ 'x-lnurlcash': note }), { sats: 10 })

      expect(result.authenticated).toBe(true)
      expect(result.mode).toBe('credit')
      expect(result.currency).toBe('sat')
      expect(result.creditBalance).toBe(21)
      expect(result.paymentId).toMatch(/^[0-9a-f]{64}$/)
      expect(storage.isSettled(result.paymentId)).toBe(true)
      expect(storage.balance(result.paymentId, 'sat')).toBe(21)
    })

    it('burns the presented note, so the same note cannot be replayed', async () => {
      const rail = createLnurlcashRail(config, memoryStorage())
      const note = fundedNote(mint, 21_000)

      const first = await rail.verify(makeReq({ 'x-lnurlcash': note }), { sats: 10 })
      expect(first.authenticated).toBe(true)

      const second = await rail.verify(makeReq({ 'x-lnurlcash': note }), { sats: 10 })
      expect(second.authenticated).toBe(false)
      expect(second.paymentId).toBe('')
    })

    it('gives each settlement its own payment id', async () => {
      const rail = createLnurlcashRail(config, memoryStorage())
      const a = await rail.verify(makeReq({ 'x-lnurlcash': fundedNote(mint, 21_000) }), { sats: 10 })
      const b = await rail.verify(makeReq({ 'x-lnurlcash': fundedNote(mint, 21_000) }), { sats: 10 })
      expect(a.authenticated && b.authenticated).toBe(true)
      expect(a.paymentId).not.toBe(b.paymentId)
    })

    it('rejects a note worth less than the route price', async () => {
      const rail = createLnurlcashRail(config, memoryStorage())
      const note = fundedNote(mint, 5_000)
      const result = await rail.verify(makeReq({ 'x-lnurlcash': note }), { sats: 10 })
      expect(result.authenticated).toBe(false)
    })

    it('leaves an under-value note spendable', async () => {
      const rail = createLnurlcashRail(config, memoryStorage())
      const note = fundedNote(mint, 5_000)
      await rail.verify(makeReq({ 'x-lnurlcash': note }), { sats: 10 })
      const result = await rail.verify(makeReq({ 'x-lnurlcash': note }), { sats: 1 })
      expect(result.authenticated).toBe(true)
    })

    it('rejects a note from a mint that is not configured', async () => {
      const rail = createLnurlcashRail({ mints: ['mint.example.com'] }, memoryStorage())
      const note = fundedNote(mint, 21_000)
      const result = await rail.verify(makeReq({ 'x-lnurlcash': note }), { sats: 10 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects a route with no price in sats', async () => {
      const rail = createLnurlcashRail(config, memoryStorage())
      const note = fundedNote(mint, 21_000)
      const result = await rail.verify(makeReq({ 'x-lnurlcash': note }), { usd: 100 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects an unknown note', async () => {
      const rail = createLnurlcashRail(config, memoryStorage())
      const note = `${mint.url}/w?k1=${newSecret()}&amount=21000`
      const result = await rail.verify(makeReq({ 'x-lnurlcash': note }), { sats: 10 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects a header that is not a note', async () => {
      const rail = createLnurlcashRail(config, memoryStorage())
      expect((await rail.verify(makeReq(), { sats: 10 })).authenticated).toBe(false)
      expect((await rail.verify(makeReq({ 'x-lnurlcash': 'not-a-note' }), { sats: 10 })).authenticated).toBe(false)
    })

    it('trusts the mint over the amount the URL declares', async () => {
      const rail = createLnurlcashRail(config, memoryStorage())
      const k1 = newSecret()
      mint.state.creditNote(k1, 5_000)
      const inflated = `${mint.url}/w?k1=${k1}&amount=100000`
      const result = await rail.verify(makeReq({ 'x-lnurlcash': inflated }), { sats: 50 })
      expect(result.authenticated).toBe(false)
    })
  })

  describe('signatures', () => {
    it('accepts a signed note when requireSignature is on', async () => {
      const rail = createLnurlcashRail({ ...config, requireSignature: true }, memoryStorage())
      const result = await rail.verify(makeReq({ 'x-lnurlcash': fundedNote(mint, 21_000) }), { sats: 10 })
      expect(result.authenticated).toBe(true)
    })

    it('rejects an unsigned note when requireSignature is on', async () => {
      const rail = createLnurlcashRail({ ...config, requireSignature: true }, memoryStorage())
      const k1 = newSecret()
      mint.state.creditNote(k1, 21_000)
      const unsigned = `${mint.url}/w?k1=${k1}&amount=21000`
      const result = await rail.verify(makeReq({ 'x-lnurlcash': unsigned }), { sats: 10 })
      expect(result.authenticated).toBe(false)
    })

    it('rejects a note whose signature does not verify', async () => {
      const rail = createLnurlcashRail({ ...config, requireSignature: true }, memoryStorage())
      const note = new URL(fundedNote(mint, 21_000))
      note.searchParams.set('sig', '00'.repeat(65))
      const result = await rail.verify(makeReq({ 'x-lnurlcash': note.toString() }), { sats: 10 })
      expect(result.authenticated).toBe(false)
    })

    it('accepts an unsigned note by default', async () => {
      const unsignedMint = await createMockMint({ signatures: false })
      try {
        const rail = createLnurlcashRail({ mints: [`127.0.0.1:${unsignedMint.port}`] }, memoryStorage())
        const result = await rail.verify(makeReq({ 'x-lnurlcash': fundedNote(unsignedMint, 21_000) }), { sats: 10 })
        expect(result.authenticated).toBe(true)
      } finally {
        await unsignedMint.close()
      }
    })
  })

  describe('onNoteReceived', () => {
    it('hands over a replacement note the booth alone can spend', async () => {
      const received: { url: string; k1: string; amountMsat: number; host: string }[] = []
      const rail = createLnurlcashRail({ ...config, onNoteReceived: n => { received.push(n) } }, memoryStorage())

      const result = await rail.verify(makeReq({ 'x-lnurlcash': fundedNote(mint, 21_000) }), { sats: 10 })
      expect(result.authenticated).toBe(true)
      expect(received).toHaveLength(1)
      expect(received[0].amountMsat).toBe(21_000)
      expect(received[0].host).toBe(`127.0.0.1:${mint.port}`)
      expect(received[0].k1).toMatch(/^[0-9a-f]{64}$/)
      expect(mint.state.noteState(received[0].k1)).toBe('outstanding')

      // The replacement is a real note: it settles for value on its own.
      const again = await rail.verify(makeReq({ 'x-lnurlcash': received[0].url }), { sats: 10 })
      expect(again.authenticated).toBe(true)
    })

    it('does not fire on a failed settlement', async () => {
      const onNoteReceived = vi.fn()
      const rail = createLnurlcashRail({ ...config, onNoteReceived }, memoryStorage())
      const note = `${mint.url}/w?k1=${newSecret()}&amount=21000`
      await rail.verify(makeReq({ 'x-lnurlcash': note }), { sats: 10 })
      expect(onNoteReceived).not.toHaveBeenCalled()
    })

    it('does not block the payment when the callback throws', async () => {
      const onNoteReceived = vi.fn(() => { throw new Error('callback exploded') })
      const rail = createLnurlcashRail({ ...config, onNoteReceived }, memoryStorage())
      const result = await rail.verify(makeReq({ 'x-lnurlcash': fundedNote(mint, 21_000) }), { sats: 10 })
      expect(result.authenticated).toBe(true)
      expect(onNoteReceived).toHaveBeenCalledOnce()
    })

    it('does not block the payment when the callback rejects', async () => {
      const onNoteReceived = vi.fn().mockRejectedValue(new Error('async callback exploded'))
      const rail = createLnurlcashRail({ ...config, onNoteReceived }, memoryStorage())
      const result = await rail.verify(makeReq({ 'x-lnurlcash': fundedNote(mint, 21_000) }), { sats: 10 })
      expect(result.authenticated).toBe(true)
      expect(onNoteReceived).toHaveBeenCalledOnce()
    })
  })

  describe('mint failures', () => {
    it('refuses when the mint is unreachable', async () => {
      const closed = await createMockMint()
      const note = fundedNote(closed, 21_000)
      const port = closed.port
      await closed.close()

      const rail = createLnurlcashRail({ mints: [`127.0.0.1:${port}`] }, memoryStorage())
      const result = await rail.verify(makeReq({ 'x-lnurlcash': note }), { sats: 10 })
      expect(result.authenticated).toBe(false)
    })

    it('refuses when the mint is too slow to answer', async () => {
      const slow = await createMockMint({ slowMs: 500 })
      try {
        const rail = createLnurlcashRail(
          { mints: [`127.0.0.1:${slow.port}`], timeoutMs: 50 },
          memoryStorage(),
        )
        const result = await rail.verify(makeReq({ 'x-lnurlcash': fundedNote(slow, 21_000) }), { sats: 10 })
        expect(result.authenticated).toBe(false)
      } finally {
        await slow.close()
      }
    })
  })
})
