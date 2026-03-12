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
