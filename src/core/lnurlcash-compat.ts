// src/core/lnurlcash-compat.ts
//
// The wire layer for LUD-25 bearer notes, written so that one booth works
// against every mint generation it may meet and every note it may hold.
//
// LUD-25 changed shape on 29 Sep 2026: every note became a taproot output
// key (`cp1<Q>`), certificates became `cs1<amount>` over hex(Q) travelling
// as `c`/`c2`, and the wire names `h`/`h2` became `p`/`p1`/`p2`. A bearer
// note is the one-leaf hashlock case, so its 64-hex preimage (`k1`) and hash
// (`h`) stay valid short forms. Mints did not all move at once:
//
//   - current mints read `p1` and its older name `h` (agreeing values),
//     look a note up by `?k1=` or `?p=`, and certify with `c` (`cs1<amount>`
//     over hex(Q));
//   - older mints, including the LUD-25 reference mint, read only `h` on
//     the callback, look up only by `?k1=`, and certify with `sig`: 65 bytes
//     of hex over the note's h.
//
// So the requests here use the forms both understand: the lookup sends the
// note's own `k1` (as every mint has always accepted), and the rotate sends
// the new note's 64-hex hash as BOTH `p1` and `h`. The protocol primitives
// (codecs, certificate digests, URL parsing) come from @lnurlcash/kit; the
// network calls are made here so that each rail keeps its own timeout and
// nothing in the host process is reconfigured behind its back.

import { randomBytes } from 'node:crypto'
import { bech32, bech32m } from '@scure/base'
import {
  AmbiguousMintError,
  ServiceError,
  classifyNoteError,
  decodeCs1WithAmount,
  encodeCs1WithAmount,
  hashK1,
  isAllowedServiceUrl,
  isCs1WithAmount,
  isPreimage,
  noteK1,
  resolveLnurlInput,
  resolveNoteInput as kitResolveNoteInput,
  verifyNoteSignature,
  verifyNoteSignatureForKey,
} from '@lnurlcash/kit'

const MAX_REDIRECTS = 5
const MAX_BODY_BYTES = 1_048_576
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const HEX_SIGNATURE = /^[0-9a-f]{130}$/i

// ---------------------------------------------------------------------------
// Note inputs
// ---------------------------------------------------------------------------

/**
 * Decode a bech32 or bech32m string with the given prefix, or null. The
 * superseded LUD-25 shapes below were bech32m; plain bech32 is tried too so
 * a value is never refused over which checksum variant its encoder used.
 */
function decodeFixed(value: string, prefix: string, length: number): Uint8Array | null {
  for (const codec of [bech32m, bech32]) {
    try {
      const decoded = codec.decode(value.trim().toLowerCase() as `${string}1${string}`, false)
      if (decoded.prefix !== prefix) continue
      const bytes = codec.fromWords(decoded.words)
      if (bytes.length === length) return bytes
    } catch {
      // try the next variant
    }
  }
  return null
}

/**
 * A key-path spend in its pre-LUD-25 shape: a 65-byte recoverable signature
 * over the fixed message `LNURLcash`. The kit no longer reads it, but a
 * current mint still redeems one, so a note carrying it is still a note.
 */
export function isLegacyCk1(value: string): boolean {
  return decodeFixed(value, 'ck', 65) !== null
}

/**
 * The note URL a header or stored value names, or null when it names none.
 *
 * Accepts every spend a mint may still honour: a 64-hex bearer preimage, a
 * current `ck1` or `cw1` (via the kit), and the pre-LUD-25 65-byte `ck1`.
 */
export function resolveNoteInput(value: string): string | null {
  const current = kitResolveNoteInput(value)
  if (current) return current
  const url = resolveLnurlInput(value)
  const k1 = url ? noteK1(url) : null
  return url && k1 && isLegacyCk1(k1) ? url : null
}

/** The spend a note URL carries, or throws. */
export function requireK1(noteUrl: string): string {
  const k1 = noteK1(noteUrl)
  if (!k1) throw new Error('Note carries no secret')
  return k1
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

/**
 * The certificate a note URL carries. LUD-25 renamed `sig` to `c`; both are
 * read, the current name first.
 */
export function noteCertificate(noteUrl: string): string | null {
  try {
    const params = new URL(noteUrl).searchParams
    return params.get('c') ?? params.get('sig')
  } catch {
    return null
  }
}

/**
 * What a certificate proves about a note:
 * - `valid`: it verifies against the mint's key under the rule for its shape;
 * - `invalid`: it is a shape with a rule, and does not verify under it;
 * - `unverifiable`: it is a superseded shape that cannot be checked offline
 *   here, so it proves nothing either way and the mint's own answer stands.
 */
export type CertificateVerdict = 'valid' | 'invalid' | 'unverifiable'

/**
 * Check a note's certificate against the mint's signing key.
 *
 * - `cs1<amount>` (current): the kit's rule, over hex(Q), with the amount in
 *   the certificate required to match.
 * - 130-hex `sig` (superseded): the pre-taproot rule, over the bearer
 *   note's h. The digest is the same Lightning signed-message construction
 *   with h in place of hex(Q), so the kit checks it once the signature is
 *   re-wrapped as a `cs1<amount>` and the note is named by h. Both byte
 *   layouts the old rule accepted (recovery id trailing, and leading as one
 *   mint once emitted it) are tried.
 * - fixed-prefix `cs1` with no amount (superseded): decoded and checked
 *   under the same pre-taproot rule.
 *
 * A superseded certificate on a key-path or script-path spend, and any
 * certificate on a pre-LUD-25 `ck1`, has no rule here and is
 * `unverifiable`.
 */
export function verifyCertificate(
  k1: string,
  amountMsat: number,
  certificate: string,
  mintPubkey: string,
): CertificateVerdict {
  const value = certificate.trim()
  // A pre-LUD-25 ck1 names its note by a key recovered from the spend,
  // which no certificate rule here covers, whatever the certificate's shape.
  if (isLegacyCk1(k1)) return 'unverifiable'
  if (isCs1WithAmount(value)) {
    return verifyNoteSignature(k1, amountMsat, value, mintPubkey) ? 'valid' : 'invalid'
  }

  let signature: Uint8Array | null = null
  if (HEX_SIGNATURE.test(value)) signature = hexToBytes(value)
  else signature = decodeFixed(value, 'cs', 65)
  if (!signature) return 'invalid'
  if (!isPreimage(k1)) return 'unverifiable'

  const h = hashK1(k1.toLowerCase())
  const layouts = [signature, new Uint8Array([...signature.subarray(1), signature[0]])]
  for (const layout of layouts) {
    try {
      const wrapped = encodeCs1WithAmount(amountMsat, layout)
      if (verifyNoteSignatureForKey(h, amountMsat, wrapped, mintPubkey)) return 'valid'
    } catch {
      // not a certificate under this layout
    }
  }
  return 'invalid'
}

/** Whether a certificate is the current `cs1<amount>` shape. */
export function isCurrentCertificate(certificate: string): boolean {
  return isCs1WithAmount(certificate.trim())
}

/**
 * A note URL for spend `k1`, in the canonical form for the certificate it
 * carries.
 *
 * - With a current certificate, it travels as `c` and the amount is left to
 *   the certificate, which names it (LUD-25 as of 29 Sep 2026).
 * - With a superseded one, it travels as `sig` alongside `amount`, the names
 *   it had when it was issued: readers that predate the change still find
 *   it, and current readers treat the note as uncertified.
 * - With none, `amount` alone.
 *
 * Whatever certificate or amount the URL carried before is dropped: it
 * described the previous spend, not this one.
 */
export function noteUrlWith(noteUrl: string, k1: string, amountMsat: number, certificate?: string): string {
  const url = new URL(noteUrl)
  url.searchParams.delete('c')
  url.searchParams.delete('sig')
  url.searchParams.delete('amount')
  url.searchParams.set('k1', k1)
  const cert = certificate?.trim()
  if (cert && isCs1WithAmount(cert) && decodeCs1WithAmount(cert)?.amountMsat === amountMsat) {
    url.searchParams.set('c', cert)
  } else {
    url.searchParams.set('amount', String(amountMsat))
    if (cert) url.searchParams.set('sig', cert)
  }
  return url.toString()
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

export interface MintCallOptions {
  /** Per-request timeout, in milliseconds. */
  timeoutMs: number
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function fetchFollowingSafeRedirects(start: string, options: MintCallOptions): Promise<Response> {
  let current = start
  for (let redirects = 0; ; redirects++) {
    let res: Response
    try {
      res = await fetch(current, { signal: AbortSignal.timeout(options.timeoutMs), redirect: 'manual' })
    } catch (error) {
      if ((error as Error)?.name === 'TimeoutError') {
        throw new AmbiguousMintError('The mint took too long to respond; its answer, if any, was lost.')
      }
      throw new AmbiguousMintError('Failed to reach the mint.')
    }
    const location = res.headers.get('location')
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res
    await res.body?.cancel().catch(() => {})
    if (redirects >= MAX_REDIRECTS) throw new AmbiguousMintError('The mint redirected too many times.')
    let next: string | null
    try {
      next = new URL(location, current).toString()
    } catch {
      next = null
    }
    if (!next || !isAllowedServiceUrl(next)) {
      throw new AmbiguousMintError('The mint redirected somewhere this booth will not fetch.')
    }
    current = next
  }
}

async function readBoundedText(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new AmbiguousMintError('The mint returned an oversized response.')
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        throw new AmbiguousMintError('The mint returned an oversized response.')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof AmbiguousMintError) throw error
    throw new AmbiguousMintError('The mint response was interrupted before it could be read.')
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * One GET to a mint, read as an LNURL response. A refusal
 * (`status: ERROR`) is classified into the kit's spent / unknown / pending
 * errors; anything that leaves the outcome unknown is an AmbiguousMintError.
 */
async function mintGet(url: URL, options: MintCallOptions): Promise<Record<string, unknown>> {
  if (!isAllowedServiceUrl(url.toString())) {
    throw new Error('Refusing to fetch that URL: only https, or http to a loopback or .onion host.')
  }
  const res = await fetchFollowingSafeRedirects(url.toString(), options)
  const text = await readBoundedText(res)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new AmbiguousMintError('The mint returned an unreadable response.')
  }
  if (!body || typeof body !== 'object') throw new AmbiguousMintError('The mint returned an unreadable response.')
  const record = body as Record<string, unknown>
  if (record.status === 'ERROR') {
    throw classifyNoteError(new ServiceError(typeof record.reason === 'string' ? record.reason : ''))
  }
  return record
}

export interface NoteInfo {
  /** The mint's mutating callback. */
  callback: string
  /** What the mint says the note is worth, in millisats. */
  maxWithdrawable: number
  /** The mint's signing key, when it publishes one. */
  mintPubkey?: string
  /** The certificate the mint attached to its answer, if any. */
  certificate?: string
}

const COMPRESSED_PUBKEY = /^0[23][0-9a-f]{64}$/i

/**
 * Ask the mint what a note is worth, by the note's own spend: the lookup
 * every mint generation answers. Any certificate on the URL is left off the
 * request. A mint that echoes a different spend than the one asked about
 * is refused, as is any answer that is not a withdrawRequest.
 */
export async function lookupNote(noteUrl: string, options: MintCallOptions): Promise<NoteInfo> {
  const k1 = requireK1(noteUrl)
  const url = new URL(noteUrl)
  url.searchParams.delete('c')
  url.searchParams.delete('sig')
  const body = await mintGet(url, options)
  const max = body.maxWithdrawable
  const min = body.minWithdrawable
  if (
    body.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof max !== 'number' ||
    !Number.isSafeInteger(max) ||
    max < 0 ||
    (min !== undefined && (typeof min !== 'number' || !Number.isSafeInteger(min) || min < 0 || min > max))
  ) {
    throw new Error('Not a withdrawRequest (unexpected response).')
  }
  if (body.k1 !== undefined && (typeof body.k1 !== 'string' || body.k1.trim().toLowerCase() !== k1.toLowerCase())) {
    throw new Error('The mint echoed a different k1 than was asked about.')
  }
  const mintPubkey =
    typeof body.mintPubkey === 'string' && COMPRESSED_PUBKEY.test(body.mintPubkey)
      ? body.mintPubkey.toLowerCase()
      : undefined
  const certificate = typeof body.c === 'string' ? body.c : typeof body.sig === 'string' ? body.sig : undefined
  return {
    callback: body.callback,
    maxWithdrawable: max,
    ...(mintPubkey && { mintPubkey }),
    ...(certificate && { certificate }),
  }
}

/** Why a rotate did not settle, with the replacement secret if it may exist. */
export class RotateError extends Error {
  /**
   * The replacement secret, when the rotate landed or may have landed:
   * the mint confirmed it, or its answer was lost. Undefined when the mint
   * refused before anything moved.
   */
  readonly newK1?: string

  constructor(cause: unknown, newK1?: string) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'RotateError'
    this.newK1 = newK1
  }
}

export interface RotateResult {
  /** The replacement secret, generated here and held only by this booth. */
  k1: string
  /** The certificate the mint returned for the new note, if any. */
  certificate?: string
}

/**
 * Rotate a note to a fresh secret generated here. Only the new secret's
 * hash goes on the wire, as both `p1` (its current name) and `h` (its
 * older name): a mint that reads either finds the same 64-hex value, and a
 * mint that reads both requires them to agree.
 *
 * A request whose answer was lost is retried once, byte for byte: LUD-25
 * has a mint replay the original success for an identical retry. If the
 * outcome is still unknown, or the mint says the note is gone after an
 * attempt may have landed, the error carries the new secret so the value
 * is never dropped. A refusal on the first attempt carries none: the mint
 * answered that request, and nothing moved.
 */
export async function rotateNote(
  callback: string,
  k1: string,
  options: MintCallOptions & { retries?: number },
): Promise<RotateResult> {
  const newK1 = randomBytes(32).toString('hex')
  const h = hashK1(newK1)
  let url: URL
  try {
    url = new URL(callback)
  } catch {
    throw new RotateError(new Error('The mint provided an invalid callback URL.'))
  }
  url.searchParams.append('k1', k1)
  url.searchParams.append('p1', h)
  url.searchParams.append('h', h)

  const retries = options.retries ?? 1
  let mayHaveLanded = false
  for (let attempt = 0; ; attempt++) {
    let body: Record<string, unknown>
    try {
      body = await mintGet(url, options)
    } catch (error) {
      if (error instanceof AmbiguousMintError) {
        mayHaveLanded = true
        if (attempt < retries) continue
        throw new RotateError(error, newK1)
      }
      // A refusal on the first attempt is the mint's answer to this very
      // request: nothing moved. After an attempt whose answer was lost, a
      // note reported spent or unknown is most likely this booth's own
      // rotate having landed, so the secret is kept.
      throw new RotateError(error, mayHaveLanded ? newK1 : undefined)
    }
    if (body.status !== 'OK') {
      throw new RotateError(new AmbiguousMintError('The rotate was not confirmed by the mint.'), newK1)
    }
    const certificate = typeof body.c === 'string' ? body.c : typeof body.sig === 'string' ? body.sig : undefined
    return { k1: newK1, ...(certificate && { certificate }) }
  }
}

/**
 * Melt a note into a Lightning invoice. Sends `k1` and `pr` only, which
 * every mint generation reads.
 */
export async function meltNote(
  callback: string,
  k1: string,
  invoice: string,
  options: MintCallOptions,
): Promise<{ verify?: string }> {
  let url: URL
  try {
    url = new URL(callback)
  } catch {
    throw new Error('The mint provided an invalid callback URL.')
  }
  url.searchParams.append('k1', k1)
  url.searchParams.append('pr', invoice.trim())
  const body = await mintGet(url, options)
  if (body.status !== 'OK') throw new AmbiguousMintError('The melt was not confirmed by the mint.')
  return typeof body.verify === 'string' ? { verify: body.verify } : {}
}
