// src/core/request-path.ts
//
// One canonical request path, shared by pricing and forwarding.
//
// Every adapter canonicalises the raw request path once, prices the request
// on the result and forwards exactly that path upstream. If pricing and
// forwarding each parsed the path their own way, a request such as
// `/x/../api/paid` could be priced as an unpriced route and still reach the
// paid upstream route after the upstream (or the fetch URL parser) resolved
// the dot segments.

/** RFC 3986 section 2.3 unreserved characters. */
const UNRESERVED_RE = /^[A-Za-z0-9\-._~]$/
const HEX_PAIR_RE = /^[0-9A-Fa-f]{2}$/

/** Longest raw path accepted. Longer paths are rejected rather than parsed. */
export const MAX_PATH_LENGTH = 8192

/**
 * Canonicalise a raw (still percent-encoded) request path.
 *
 * - decodes percent-encoded unreserved characters (`%70` becomes `p`) and
 *   upper-cases the hex digits of every other escape;
 * - rejects encoded `/` (`%2F`), encoded `\` (`%5C`), literal backslashes,
 *   malformed escapes, and dot segments spelt with an encoded dot (`%2e%2e`);
 * - rejects `;` and its encoding `%3B`. Many upstreams (Tomcat, Jetty,
 *   Spring, some proxies) strip `;` path parameters before routing, so
 *   `/paid;x=1` or `/free/..;/paid` would be priced as one path here and
 *   served as another there;
 * - resolves `.` and `..` segments (RFC 3986 section 5.2.4), never climbing
 *   above the root;
 * - collapses duplicate slashes.
 *
 * A single trailing slash is kept, because some upstreams distinguish it;
 * pricing ignores it (see {@link normalisePath}).
 *
 * Case is preserved: the canonical path is what gets forwarded. Pricing
 * lookups are case-insensitive, so a case-insensitive upstream cannot be
 * reached for free through `/API/paid`.
 *
 * @returns The canonical path, or `null` when the path must be rejected
 *          with 400 Bad Request.
 */
export function canonicalisePath(rawPath: string): string | null {
  if (typeof rawPath !== 'string' || rawPath.length > MAX_PATH_LENGTH) return null
  if (rawPath === '') return '/'
  if (!rawPath.startsWith('/')) return null
  if (rawPath.includes('\\')) return null
  // Path parameters: see the note above. `%3B` is caught below.
  if (rawPath.includes(';')) return null

  const rawSegments = rawPath.slice(1).split('/')
  const out: string[] = []
  let trailingSlash = false

  for (let s = 0; s < rawSegments.length; s++) {
    const raw = rawSegments[s]
    const isLast = s === rawSegments.length - 1
    let seg = ''
    let encodedDot = false

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (ch !== '%') {
        seg += ch
        continue
      }
      const hex = raw.slice(i + 1, i + 3)
      if (!HEX_PAIR_RE.test(hex)) return null
      const code = parseInt(hex, 16)
      if (code === 0x2f || code === 0x5c || code === 0x3b) return null
      const decoded = String.fromCharCode(code)
      if (UNRESERVED_RE.test(decoded)) {
        if (decoded === '.') encodedDot = true
        seg += decoded
      } else {
        seg += '%' + hex.toUpperCase()
      }
      i += 2
    }

    if (seg === '') {
      if (isLast) trailingSlash = out.length > 0
      continue
    }
    if (seg === '.' || seg === '..') {
      if (encodedDot) return null
      if (seg === '..') out.pop()
      if (isLast) trailingSlash = out.length > 0
      continue
    }
    out.push(seg)
  }

  if (out.length === 0) return '/'
  return '/' + out.join('/') + (trailingSlash ? '/' : '')
}

/**
 * Split a raw request target (`/path?query`, or absolute-form
 * `http://host/path?query`) into its path and search parts without
 * resolving or decoding anything. The fragment, if any, is dropped.
 */
export function splitRequestTarget(target: string): { path: string; search: string } {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(target)) {
    // Absolute-form (RFC 9112 section 3.2.2): the authority is ignored so a
    // client cannot redirect the proxied request to another host.
    const afterScheme = target.indexOf('//') + 2
    const pathStart = target.slice(afterScheme).search(/[/?#]/)
    target = pathStart === -1 ? '/' : target.slice(afterScheme + pathStart)
    if (!target.startsWith('/')) target = '/' + target
  }
  const hash = target.indexOf('#')
  if (hash !== -1) target = target.slice(0, hash)
  const q = target.indexOf('?')
  if (q === -1) return { path: target, search: '' }
  const search = target.slice(q)
  return { path: target.slice(0, q), search: search === '?' ? '' : search }
}
