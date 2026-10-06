// The lnurlcash rail and the melt helper against real mints, not mocks:
// moneyer 0.17 (LUD-25 as revised for unified taproot notes) and moneyer
// 0.3.1, which predates it, as an older mint still in service does. The
// older one looks notes up only by `?k1=`, reads only `h` on its callback
// and certifies with `sig` = hex over the note's h. Nothing is mocked but
// the Lightning node behind each mint.

import { describe, it, expect, afterEach } from 'vitest'
import { createMoneyer, createFakeBackend, fakeBolt11 } from '@forgesworn/moneyer'
import {
  createMoneyer as createLegacyMoneyer,
  createFakeBackend as createLegacyFakeBackend,
} from 'moneyer-legacy'
import { buildNoteUrl, fetchPayRequest, hashK1, requestInvoice } from '@lnurlcash/kit'
import { decodeBolt11 } from 'farrier-kit/bolt11'
import { randomBytes } from 'node:crypto'
import { createLnurlcashRail } from './lnurlcash-rail.js'
import { meltNoteToLightning } from './melt-note-to-lightning.js'
import { lookupNote } from './lnurlcash-compat.js'
import { memoryStorage } from '../storage/memory.js'
import type { ReceivedNote } from '../types.js'

type Generation = 'current' | 'legacy'

interface TestMint {
  generation: Generation
  url: string
  host: string
  close: () => Promise<void>
  control: {
    settleInvoice(paymentHashHex: string): void
    invoiceByHash(paymentHashHex: string): { preimageHex: string } | undefined
  }
}

let mint: TestMint | null = null

afterEach(async () => {
  await mint?.close()
  mint = null
})

async function startMint(generation: Generation): Promise<TestMint> {
  const config = {
    host: '127.0.0.1',
    port: 0,
    username: 'mint',
    description: 'an LNURLcash note',
    minSendableMsat: 1000,
    maxSendableMsat: 100_000_000,
    minMintMsat: 1000,
    mintFee: null,
    signingKey: randomBytes(32).toString('hex'),
    dbPath: ':memory:',
    backend: { kind: 'fake' as const },
    verify: true,
    maxK1s: 21,
    sunset: false,
  }
  if (generation === 'current') {
    const backend = createFakeBackend()
    const m = await createMoneyer(config, { backend, confirmDelaysMs: [0, 10] })
    mint = { generation, url: m.url, host: new URL(m.url).host, close: () => m.close(), control: backend.control }
  } else {
    const backend = createLegacyFakeBackend()
    const m = await createLegacyMoneyer(config, { backend, confirmDelaysMs: [0, 10] })
    mint = { generation, url: m.url, host: new URL(m.url).host, close: () => m.close(), control: backend.control }
  }
  return mint
}

/**
 * Buy a note the way a wallet of the mint's generation does: a current mint
 * strikes the note the quote names, so the wallet picks its own secret; an
 * older one makes the invoice's preimage the secret.
 */
async function buyNote(m: TestMint, amountMsat: number): Promise<{ url: string; k1: string }> {
  const pay = await fetchPayRequest(`${m.url}/.well-known/lnurlp/mint`)
  if (m.generation === 'current') {
    const k1 = randomBytes(32).toString('hex')
    const invoice = await requestInvoice(pay.callback, amountMsat, hashK1(k1))
    m.control.settleInvoice(decodeBolt11(invoice.pr)!.paymentHashHex)
    return { url: buildNoteUrl(`${m.url}/w`, k1), k1 }
  }
  const invoice = await requestInvoice(pay.callback, amountMsat)
  const paymentHash = decodeBolt11(invoice.pr)!.paymentHashHex
  m.control.settleInvoice(paymentHash)
  const k1 = m.control.invoiceByHash(paymentHash)!.preimageHex
  return { url: buildNoteUrl(`${m.url}/w`, k1), k1 }
}

const operatorInvoice = async (amountSats: number): Promise<string> => {
  const preimage = randomBytes(32).toString('hex')
  return fakeBolt11({ amountMsat: amountSats * 1000, paymentHashHex: hashK1(preimage) })
}

const isLive = async (url: string): Promise<boolean> => {
  try {
    await lookupNote(url, { timeoutMs: 5_000 })
    return true
  } catch {
    return false
  }
}

describe.each(['current', 'legacy'] as const)('lnurlcash against a real %s mint', (generation) => {
  for (const requireSignature of [false, true]) {
    it(`settles a freshly bought note and melts the replacement (requireSignature: ${requireSignature})`, async () => {
      const m = await startMint(generation)
      const bought = await buyNote(m, 21_000)

      // The payer's note, with whatever certificate the mint gives for it,
      // under the name that mint generation uses.
      const info = await lookupNote(bought.url, { timeoutMs: 5_000 })
      const presented = new URL(bought.url)
      if (info.certificate) presented.searchParams.set(generation === 'current' ? 'c' : 'sig', info.certificate)
      let held: ReceivedNote | undefined
      const rail = createLnurlcashRail(
        { mints: [m.host], requireSignature, onNoteReceived: (n) => { held = n } },
        memoryStorage(),
      )
      const result = await rail.verify(
        { method: 'GET', path: '/api', headers: { 'x-lnurlcash': presented.toString() }, ip: '127.0.0.1' },
        { sats: 10 },
      )

      // moneyer 0.3.1 certifies a note on rotate, never on lookup, so a note
      // bought from it carries no certificate until someone rotates it.
      expect(Boolean(info.certificate)).toBe(generation === 'current')
      if (requireSignature && !info.certificate) {
        // An uncertified note is refused when certificates are required,
        // and left untouched at the mint. The test below covers one this
        // older mint did certify.
        expect(result.authenticated).toBe(false)
        expect(await isLive(bought.url)).toBe(true)
        return
      }

      expect(result.authenticated).toBe(true)
      expect(await isLive(bought.url)).toBe(false)
      expect(held).toBeDefined()
      const written = new URL(held!.url)
      if (generation === 'current') {
        expect(written.searchParams.get('c')).toMatch(/^cs/)
        expect(written.searchParams.get('sig')).toBeNull()
      } else {
        expect(written.searchParams.get('sig')).toMatch(/^[0-9a-f]{130}$/)
        expect(written.searchParams.get('amount')).toBe('21000')
      }

      const melted = await meltNoteToLightning({ noteUrl: held!.url, createInvoice: operatorInvoice })
      expect(melted).toMatchObject({ accepted: true, amountSats: 21 })
    })
  }

  it('melts a note in the shape toll-booth 6.2.6 stored it', async () => {
    const m = await startMint(generation)
    const bought = await buyNote(m, 21_000)
    // 6.2.6 wrote k1, amount and the rotate's `sig`, and kept anything else
    // the presented URL carried. A stale certificate stands in for both.
    const stored = new URL(bought.url)
    stored.searchParams.set('amount', '21000')
    stored.searchParams.set('sig', 'ab'.repeat(65))
    stored.searchParams.set('c', 'cs210n1stale')

    const melted = await meltNoteToLightning({ noteUrl: stored.toString(), createInvoice: operatorInvoice })

    expect(melted).toMatchObject({ accepted: true, amountSats: 21 })
  })
})

describe('the certificate an older mint gives on rotate', () => {
  it('is verified under the pre-taproot rule when signatures are required', async () => {
    const m = await startMint('legacy')
    // First booth takes the note and receives a rotated note carrying the
    // older mint's hex `sig`. A second booth requiring signatures then takes
    // that note as payment: the old certificate must not be why it fails.
    const bought = await buyNote(m, 21_000)
    let held: ReceivedNote | undefined
    const first = createLnurlcashRail({ mints: [m.host], onNoteReceived: (n) => { held = n } }, memoryStorage())
    const req = (note: string) => ({ method: 'GET', path: '/api', headers: { 'x-lnurlcash': note }, ip: '127.0.0.1' })
    expect((await first.verify(req(bought.url), { sats: 10 })).authenticated).toBe(true)
    expect(new URL(held!.url).searchParams.get('sig')).toMatch(/^[0-9a-f]{130}$/)

    const strict = createLnurlcashRail({ mints: [m.host], requireSignature: true }, memoryStorage())
    expect((await strict.verify(req(held!.url), { sats: 10 })).authenticated).toBe(true)
  })
})
