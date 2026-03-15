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

/**
 * Extracts and validates the client IP from an X-Forwarded-For header value.
 * Returns the first entry if it looks like an IP, otherwise returns undefined.
 */
export function parseForwardedIp(header: string | null | undefined): string | undefined {
  if (!header) return undefined
  const first = header.split(',')[0]?.trim()
  if (!first || !isPlausibleIp(first)) return undefined
  return first
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
