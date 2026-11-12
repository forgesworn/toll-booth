// Compatibility across the 29 Sep 2026 LUD-25 change, graded against real
// mock mints of both generations rather than assumed:
//
//   - `current`: lnurlcash-conformance 0.15, LUD-25 as of luds 50d740a.
//     Certifies with `c` = cs1<amount> over hex(Q), reads `p1` (or `h`).
//   - `legacy`: lnurlcash-conformance 0.13.1, the protocol before it, which
//     is also what the LUD-25 reference mint still speaks: looks notes up
//     by `?k1=` (or `?h=`), reads only `h` on the callback, and certifies
//     with `sig` = 65 bytes of hex over the bearer note's h.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createMockMint } from 'lnurlcash-conformance/mock-mint'
import type { MockMint } from 'lnurlcash-conformance/mock-mint'
import { createMockMint as createLegacyMockMint } from 'lnurlcash-conformance-0-13/mock-mint'
import { randomBytes } from 'node:crypto'
import { bech32m } from '@scure/base'
import { hashK1, noteCertificateKind, rotateNoteWithHashShort } from '@lnurlcash/kit'
import { createLnurlcashRail } from './lnurlcash-rail.js'
import { meltNoteToLightning } from './melt-note-to-lightning.js'
import {
  isLegacyCk1,
  lookupNote,
  noteCertificate,
  noteUrlWith,
  resolveNoteInput,
  verifyCertificate,
} from './lnurlcash-compat.js'
import { memoryStorage } from '../storage/memory.js'
import type { TollBoothRequest } from './types.js'
import type { ReceivedNote } from '../types.js'

interface AnyMint {
  url: string
  port: number
  state: {
    creditNote(k1: string, amountMsat: number): string | undefined
    noteState(k1: string): string | null
  }
  close(): Promise<void>
}

const newSecret = (): string => randomBytes(32).toString('hex')
const makeReq = (note: string): TollBoothRequest => ({
  method: 'GET',
  path: '/api',
  headers: { 'x-lnurlcash': note },
  ip: '127.0.0.1',
})
const invoice = async (sats: number): Promise<string> => `lnbc${sats}n1fakeinvoice`
const hostOf = (m: AnyMint): string => `127.0.0.1:${m.port}`

/** A note URL as a payer presents it, with its certificate under `name`. */
function noteOn(m: AnyMint, name: 'c' | 'sig' | null, amountMsat = 21_000, k1 = newSecret()) {
  const cert = m.state.creditNote(k1, amountMsat)
  const url = new URL(`${m.url}/w`)
  url.searchParams.set('k1', k1)
  url.searchParams.set('amount', String(amountMsat))
  if (name && cert) url.searchParams.set(name, cert)
  return { url: url.toString(), k1, cert: cert! }
}

/**
 * The note URL toll-booth 6.2.6 handed to `onNoteReceived`, and so the
 * shape an operator may have stored: the presented URL with `k1` replaced,
 * `amount` set, and the rotate's signature as `sig` (deleted when there was
 * none). Anything else the presented URL carried, a `c` included, was kept.
 * Captured from a real 6.2.6 run against both mock generations:
 *
 *   legacy:  /w?k1=<hex>&amount=21000&sig=<130 hex>
 *   current: /w?k1=<hex>&amount=21000&c=<the PAYER's cs1, now stale>
 */
function storedBy626(presented: string, k1: string, amountMsat: number, signature?: string): string {
  const url = new URL(presented)
  url.searchParams.set('k1', k1.toLowerCase())
  url.searchParams.set('amount', String(amountMsat))
  if (signature) url.searchParams.set('sig', signature)
  else url.searchParams.delete('sig')
  return url.toString()
}

async function settle(
  m: AnyMint,
  note: string,
  requireSignature: boolean,
): Promise<{ authenticated: boolean; held?: ReceivedNote }> {
  let held: ReceivedNote | undefined
  const rail = createLnurlcashRail(
    { mints: [hostOf(m)], requireSignature, onNoteReceived: (n) => { held = n } },
    memoryStorage(),
  )
  const result = await rail.verify(makeReq(note), { sats: 10 })
  return { authenticated: result.authenticated, held }
}

describe('lnurlcash compatibility', () => {
  let current: MockMint
  let currentSigName: MockMint
  let currentBoth: MockMint
  let legacy: AnyMint
  let legacyLeading: AnyMint
  let legacyUnsigned: AnyMint

  beforeAll(async () => {
    current = await createMockMint()
    currentSigName = await createMockMint({ certificateNames: 'sig' })
    currentBoth = await createMockMint({ certificateNames: 'both' })
    legacy = await createLegacyMockMint()
    legacyLeading = await createLegacyMockMint({ signatureLayout: 'leading' })
    legacyUnsigned = await createLegacyMockMint({ signatures: false })
  })

  afterAll(async () => {
    await Promise.all(
      [current, currentSigName, currentBoth, legacy, legacyLeading, legacyUnsigned].map((m) => m.close()),
    )
  })

  describe('incoming notes, both shapes, both mint generations', () => {
    for (const requireSignature of [false, true]) {
      describe(`requireSignature: ${requireSignature}`, () => {
        it('takes a current note (c = cs1<amount>) from a current mint', async () => {
          const { url, k1 } = noteOn(current, 'c')
          const { authenticated, held } = await settle(current, url, requireSignature)
          expect(authenticated).toBe(true)
          expect(current.state.noteState(k1)).toBe('burned')
          expect(current.state.noteState(held!.k1)).toBe('outstanding')
        })

        it('takes a current certificate under the older name (sig = cs1<amount>)', async () => {
          const { url } = noteOn(currentSigName, 'sig')
          expect((await settle(currentSigName, url, requireSignature)).authenticated).toBe(true)
        })

        it('takes a note certified under both names', async () => {
          const k1 = newSecret()
          const cert = currentBoth.state.creditNote(k1, 21_000)!
          const url = `${currentBoth.url}/w?k1=${k1}&c=${cert}&sig=${cert}`
          expect((await settle(currentBoth, url, requireSignature)).authenticated).toBe(true)
        })

        it('takes an old note (sig = hex over h) from an old mint', async () => {
          const { url, k1 } = noteOn(legacy, 'sig')
          const { authenticated, held } = await settle(legacy, url, requireSignature)
          expect(authenticated).toBe(true)
          expect(legacy.state.noteState(k1)).toBe('burned')
          expect(legacy.state.noteState(held!.k1)).toBe('outstanding')
        })

        it('takes an old note whose hex signature leads with its recovery id', async () => {
          const { url } = noteOn(legacyLeading, 'sig')
          expect((await settle(legacyLeading, url, requireSignature)).authenticated).toBe(true)
        })

        it('takes an old note with a fixed-prefix cs1 (no amount)', async () => {
          const { url, cert } = noteOn(legacy, null)
          const bytes = Uint8Array.from(Buffer.from(cert, 'hex'))
          const cs1 = bech32m.encode('cs', bech32m.toWords(bytes), false)
          const note = `${url}&sig=${cs1}`
          expect((await settle(legacy, note, requireSignature)).authenticated).toBe(true)
        })

        it('takes an old note presented under the new name (c = hex)', async () => {
          const { url, cert } = noteOn(legacy, null)
          expect((await settle(legacy, `${url}&c=${cert}`, requireSignature)).authenticated).toBe(true)
        })
      })
    }

    it('still refuses a forged old certificate when signatures are required', async () => {
      const other = noteOn(legacy, null)
      const { url, k1 } = noteOn(legacy, null)
      const forged = `${url}&sig=${other.cert}`
      expect((await settle(legacy, forged, true)).authenticated).toBe(false)
      expect(legacy.state.noteState(k1)).toBe('outstanding')
      // Without the requirement the mint's answer is what counts.
      expect((await settle(legacy, forged, false)).authenticated).toBe(true)
    })

    it('still refuses a current certificate for a different amount', async () => {
      const { url, k1 } = noteOn(current, null)
      const wrong = current.state.creditNote(newSecret(), 42_000)!
      expect((await settle(current, `${url}&c=${wrong}`, true)).authenticated).toBe(false)
      expect(current.state.noteState(k1)).toBe('outstanding')
    })

    it('refuses an uncertified note only when signatures are required', async () => {
      const { url } = noteOn(legacyUnsigned, null)
      expect((await settle(legacyUnsigned, url, true)).authenticated).toBe(false)
      expect((await settle(legacyUnsigned, url, false)).authenticated).toBe(true)
    })
  })

  describe('the wire both generations read', () => {
    it("is needed: the kit's own short-form rotate is refused by an h-only mint", async () => {
      const { url, k1 } = noteOn(legacy, 'sig')
      const info = await lookupNote(url, { timeoutMs: 5_000 })
      await expect(rotateNoteWithHashShort(info.callback, k1, hashK1(newSecret()))).rejects.toThrow(/missing h/)
      expect(legacy.state.noteState(k1)).toBe('outstanding')
    })

    it('looks notes up by k1 on both generations, leaving certificates off the wire', async () => {
      for (const m of [current, legacy] as AnyMint[]) {
        const { url } = noteOn(m, m === legacy ? 'sig' : 'c')
        const info = await lookupNote(url, { timeoutMs: 5_000 })
        expect(info.maxWithdrawable).toBe(21_000)
        expect(info.mintPubkey).toMatch(/^0[23][0-9a-f]{64}$/)
      }
    })

    it('refuses a lookup answer that echoes a different k1', async () => {
      const liar = await createMockMint({ echoWrongK1: true })
      try {
        const { url } = noteOn(liar, 'c')
        await expect(lookupNote(url, { timeoutMs: 5_000 })).rejects.toThrow(/different k1/)
      } finally {
        await liar.close()
      }
    })
  })

  describe('notes written from now on', () => {
    it('writes c = cs1<amount> and no amount when the mint certifies the current way', async () => {
      const { url } = noteOn(current, 'c')
      const { held } = await settle(current, url, false)
      const written = new URL(held!.url)
      expect(written.searchParams.get('sig')).toBeNull()
      expect(written.searchParams.get('amount')).toBeNull()
      const c = written.searchParams.get('c')!
      expect(verifyCertificate(held!.k1, held!.url, 21_000, c, (await lookupNote(held!.url, { timeoutMs: 5_000 })).mintPubkey!)).toBe('valid')
    })

    it('writes the payer certificate nowhere: an old mint uncertified rotate leaves amount alone', async () => {
      const { url } = noteOn(legacyUnsigned, null)
      const { held } = await settle(legacyUnsigned, `${url}&c=stale&sig=stale`, false)
      const written = new URL(held!.url)
      expect(written.searchParams.get('c')).toBeNull()
      expect(written.searchParams.get('sig')).toBeNull()
      expect(written.searchParams.get('amount')).toBe('21000')
    })

    it('writes an old mint certificate as sig with amount, the names it was issued under', async () => {
      const { url } = noteOn(legacy, 'sig')
      const { held } = await settle(legacy, url, true)
      const written = new URL(held!.url)
      expect(written.searchParams.get('c')).toBeNull()
      expect(written.searchParams.get('amount')).toBe('21000')
      const sig = written.searchParams.get('sig')!
      expect(sig).toMatch(/^[0-9a-f]{130}$/)
      const { mintPubkey } = await lookupNote(held!.url, { timeoutMs: 5_000 })
      expect(verifyCertificate(held!.k1, held!.url, 21_000, sig, mintPubkey!)).toBe('valid')
    })

    for (const [name, pick] of [
      ['a current mint', () => current],
      ['an old mint', () => legacy],
    ] as const) {
      it(`melts a note it took from ${name}`, async () => {
        const m = pick() as AnyMint
        const { url } = noteOn(m, m === legacy ? 'sig' : 'c')
        const { held } = await settle(m, url, false)
        const result = await meltNoteToLightning({ noteUrl: held!.url, createInvoice: invoice })
        expect(result).toMatchObject({ accepted: true, amountSats: 21 })
        expect(m.state.noteState(held!.k1)).not.toBe('outstanding')
      })
    }
  })

  describe('certificates bound to the mint domain', () => {
    // Since luds 92abbb3 a certificate signs LNURLcash:<domain>:<amount>:<hex(Q)>,
    // the domain being the hostname the note URL names. The 0.16 mock signs
    // the old domain-less message until its first request tells it where it
    // was reached, so each mint here is asked something first.
    const warmed = async (options: Parameters<typeof createMockMint>[0]): Promise<MockMint> => {
      const m = await createMockMint(options)
      await lookupNote(noteOn(m, null).url, { timeoutMs: 5_000 })
      return m
    }

    it('keeps a rotated certificate the mint bound to the note URL domain', async () => {
      const m = await warmed({})
      try {
        const { url } = noteOn(m, 'c')
        const { authenticated, held } = await settle(m, url, true)
        expect(authenticated).toBe(true)
        const c = new URL(held!.url).searchParams.get('c')!
        const { mintPubkey } = await lookupNote(held!.url, { timeoutMs: 5_000 })
        expect(noteCertificateKind(held!.k1, held!.url, 21_000, c, mintPubkey!)).toBe('current')
        expect(verifyCertificate(held!.k1, held!.url, 21_000, c, mintPubkey!)).toBe('valid')
      } finally {
        await m.close()
      }
    })

    it('refuses a certificate bound to another domain when signatures are required', async () => {
      const m = await warmed({ domains: 'other.example' })
      try {
        const { url, k1, cert } = noteOn(m, 'c')
        const { mintPubkey } = await lookupNote(url, { timeoutMs: 5_000 })
        // The same certificate, judged against the domain it names and the
        // one the note URL names.
        expect(verifyCertificate(k1, 'https://other.example/w', 21_000, cert, mintPubkey!)).toBe('valid')
        expect(verifyCertificate(k1, url, 21_000, cert, mintPubkey!)).toBe('invalid')

        expect((await settle(m, url, true)).authenticated).toBe(false)
        expect(m.state.noteState(k1)).toBe('outstanding')

        // Without the requirement the mint's answer is what counts, and the
        // rotated certificate, bound to the other domain too, is not kept.
        const { authenticated, held } = await settle(m, url, false)
        expect(authenticated).toBe(true)
        const written = new URL(held!.url)
        expect(written.searchParams.get('c')).toBeNull()
        expect(written.searchParams.get('sig')).toBeNull()
        expect(written.searchParams.get('amount')).toBe('21000')
      } finally {
        await m.close()
      }
    })

    it('still takes a certificate over the message before the domain was bound', async () => {
      const m = await warmed({ certificateWithoutDomain: true } as Parameters<typeof createMockMint>[0])
      try {
        const { url, k1, cert } = noteOn(m, 'c')
        const { mintPubkey } = await lookupNote(url, { timeoutMs: 5_000 })
        expect(noteCertificateKind(k1, url, 21_000, cert, mintPubkey!)).toBe('legacy')
        expect((await settle(m, url, true)).authenticated).toBe(true)
      } finally {
        await m.close()
      }
    })
  })

  describe('notes stored by toll-booth 6.2.6', () => {
    it('melts one held against an old mint (k1, amount, sig = hex)', async () => {
      const presented = noteOn(legacy, 'sig')
      const k1 = newSecret()
      const sig = legacy.state.creditNote(k1, 21_000)
      const stored = storedBy626(presented.url, k1, 21_000, sig)
      expect(new URL(stored).searchParams.get('sig')).toMatch(/^[0-9a-f]{130}$/)

      const result = await meltNoteToLightning({ noteUrl: stored, createInvoice: invoice })

      expect(result).toMatchObject({ accepted: true, amountSats: 21 })
      expect(legacy.state.noteState(k1)).not.toBe('outstanding')
    })

    it('melts one held against a current mint, stale payer c and all', async () => {
      const presented = noteOn(current, 'c')
      const k1 = newSecret()
      current.state.creditNote(k1, 21_000)
      // 6.2.6 read only `sig`, so it found no certificate on the rotate and
      // kept the payer's `c`, which names a different note.
      const stored = storedBy626(presented.url, k1, 21_000)
      expect(new URL(stored).searchParams.get('c')).toBe(presented.cert)

      const result = await meltNoteToLightning({ noteUrl: stored, createInvoice: invoice })

      expect(result).toMatchObject({ accepted: true, amountSats: 21 })
      expect(current.state.noteState(k1)).not.toBe('outstanding')
    })

    it('melts one held in the LUD-17 spelling', async () => {
      const k1 = newSecret()
      const sig = legacy.state.creditNote(k1, 21_000)
      const stored = `lnurlw://${hostOf(legacy)}/w?k1=${k1}&amount=21000&sig=${sig}`
      const result = await meltNoteToLightning({ noteUrl: stored, createInvoice: invoice })
      expect(result).toMatchObject({ accepted: true, amountSats: 21 })
    })

    it('still takes one as payment, when its mint confirms it', async () => {
      const k1 = newSecret()
      const sig = legacy.state.creditNote(k1, 21_000)
      const stored = storedBy626(`${legacy.url}/w?k1=${newSecret()}`, k1, 21_000, sig)
      expect((await settle(legacy, stored, true)).authenticated).toBe(true)
    })
  })

  describe('key-path spends', () => {
    it('recognises a pre-LUD-25 ck1 (65 bytes) as a note, and leaves judging it to the mint', () => {
      const ck1 = bech32m.encode('ck', bech32m.toWords(randomBytes(65)), false)
      expect(isLegacyCk1(ck1)).toBe(true)
      expect(resolveNoteInput(`https://mint.example.com/w?k1=${ck1}`)).not.toBeNull()
      // Its certificate has no offline rule here, so it decides nothing.
      expect(verifyCertificate(ck1, 'https://mint.example.com', 21_000, 'ab'.repeat(65), '02' + 'ab'.repeat(32))).toBe('unverifiable')
      const cs1 = current.state.creditNote(newSecret(), 21_000)!
      expect(verifyCertificate(ck1, 'https://mint.example.com', 21_000, cs1, '02' + 'ab'.repeat(32))).toBe('unverifiable')
    })

    it('refuses something that is no spend at all', () => {
      expect(resolveNoteInput('https://mint.example.com/w?k1=ck1notreal')).toBeNull()
      expect(isLegacyCk1(bech32m.encode('ck', bech32m.toWords(randomBytes(40)), false))).toBe(false)
    })
  })

  describe('noteUrlWith', () => {
    const base = 'https://mint.example.com/w?k1=' + 'a'.repeat(64) + '&amount=1&c=old&sig=old'

    it('drops whatever certificate and amount described the previous spend', () => {
      const url = new URL(noteUrlWith(base, 'b'.repeat(64), 21_000))
      expect(url.searchParams.get('k1')).toBe('b'.repeat(64))
      expect(url.searchParams.get('amount')).toBe('21000')
      expect(url.searchParams.get('c')).toBeNull()
      expect(url.searchParams.get('sig')).toBeNull()
    })

    it('reads c before sig', () => {
      expect(noteCertificate('https://m.example/w?k1=x&sig=old&c=new')).toBe('new')
      expect(noteCertificate('https://m.example/w?k1=x&sig=old')).toBe('old')
    })
  })

  it('never lets a slow mint hold a caller past the timeout', async () => {
    const slow = await createLegacyMockMint({ slowMs: 500 })
    try {
      const { url } = noteOn(slow, 'sig')
      const createInvoice = vi.fn()
      const result = await meltNoteToLightning({ noteUrl: url, createInvoice, timeoutMs: 50 })
      expect(result.accepted).toBe(false)
      expect(createInvoice).not.toHaveBeenCalled()
    } finally {
      await slow.close()
    }
  })
})
