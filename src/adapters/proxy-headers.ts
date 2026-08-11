const BASE_HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

type HeaderSource = Headers | Record<string, string> | Array<[string, string]>

export function stripProxyRequestHeaders(source: HeaderSource): Headers {
  const headers = new Headers(source)
  const disallowed = collectDisallowedHeaders(headers)
  disallowed.add('authorization')
  disallowed.add('host')

  for (const name of disallowed) {
    headers.delete(name)
  }

  return headers
}

export function stripProxyResponseHeaders(source: HeaderSource): Headers {
  const headers = new Headers(source)
  const disallowed = collectDisallowedHeaders(headers)

  for (const name of disallowed) {
    headers.delete(name)
  }

  return headers
}

export function applyNoStoreHeaders(headers: Headers): Headers {
  headers.set('Cache-Control', 'no-store')
  headers.set('Pragma', 'no-cache')
  headers.set('X-Content-Type-Options', 'nosniff')
  return headers
}

/** Applies security headers suitable for HTML pages (payment page). */
export function applySecurityHeaders(headers: Headers): Headers {
  applyNoStoreHeaders(headers)
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'",
  )
  return headers
}

export function appendVary(headers: Headers, value: string): Headers {
  const current = headers.get('Vary')
  if (!current) {
    headers.set('Vary', value)
    return headers
  }

  const values = new Set(current.split(',').map(v => v.trim()).filter(Boolean))
  values.add(value)
  headers.set('Vary', Array.from(values).join(', '))
  return headers
}

/**
 * Validates that a string looks like a plausible IP address (IPv4 or IPv6).
 * Rejects obvious non-IP values to prevent free-tier and rate-limit bypass
 * via crafted X-Forwarded-For headers.
 */
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/
const IPV6_RE = /^[0-9a-fA-F:]{2,45}$/

export function isPlausibleIp(value: string): boolean {
  if (!value || value.length > 45) return false
  if (IPV4_RE.test(value)) {
    // Reject octets > 255
    return value.split('.').every(o => parseInt(o, 10) <= 255)
  }
  // IPv6 must contain at least one colon
  return IPV6_RE.test(value) && value.includes(':')
}

function ipv4ToInt(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return undefined
  const octets = m.slice(1).map(Number)
  if (octets.some(o => o > 255)) return undefined
  return ((octets[0] * 2 ** 24) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0
}

/**
 * Checks whether `ip` matches an entry of `trustedProxies`. Entries are
 * exact IPs (v4 or v6) or IPv4 CIDR ranges (e.g. "10.0.0.0/8").
 */
export function isTrustedProxyIp(ip: string, trustedProxies: string[]): boolean {
  const target = ip.trim().toLowerCase()
  const targetV4 = ipv4ToInt(target)
  return trustedProxies.some(rawEntry => {
    const entry = rawEntry.trim().toLowerCase()
    const slash = entry.indexOf('/')
    if (slash === -1) return entry === target
    // CIDR notation is supported for IPv4 only.
    const baseV4 = ipv4ToInt(entry.slice(0, slash))
    const bits = parseInt(entry.slice(slash + 1), 10)
    if (baseV4 === undefined || targetV4 === undefined || Number.isNaN(bits) || bits < 0 || bits > 32) {
      return false
    }
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (baseV4 & mask) === (targetV4 & mask)
  })
}

/**
 * Extracts and validates the client IP from an X-Forwarded-For header value.
 *
 * Entries are resolved right-to-left: proxies such as nginx
 * (`$proxy_add_x_forwarded_for`) *append* to a client-supplied header, so
 * the left-most entry is trivially spoofable while the right-most is the
 * address observed by the closest proxy. When `trustedProxies` is given,
 * entries matching it are skipped while walking right-to-left, so multi-hop
 * proxy chains still resolve to the real client; if every hop is trusted the
 * left-most entry is the best-known answer. Returns undefined when no entry
 * looks like a plausible IP.
 */
export function parseForwardedIp(
  header: string | null | undefined,
  trustedProxies?: string[],
): string | undefined {
  if (!header) return undefined
  const entries = header
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0 && isPlausibleIp(s))
  if (entries.length === 0) return undefined

  if (trustedProxies && trustedProxies.length > 0) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!isTrustedProxyIp(entries[i], trustedProxies)) return entries[i]
    }
    return entries[0]
  }

  return entries[entries.length - 1]
}

function collectDisallowedHeaders(headers: Headers): Set<string> {
  const disallowed = new Set(BASE_HOP_BY_HOP_HEADERS)
  const connection = headers.get('connection')

  if (connection) {
    for (const token of connection.split(',')) {
      const name = token.trim().toLowerCase()
      if (name) disallowed.add(name)
    }
  }

  return disallowed
}
