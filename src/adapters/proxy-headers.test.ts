import { describe, expect, it } from 'vitest'
import {
  appendVary,
  applyNoStoreHeaders,
  applySecurityHeaders,
  isPlausibleIp,
  isTrustedProxyIp,
  parseForwardedIp,
  stripProxyRequestHeaders,
  stripProxyResponseHeaders,
} from './proxy-headers.js'

describe('proxy header helpers', () => {
  it('strips hop-by-hop request headers plus auth headers', () => {
    const headers = stripProxyRequestHeaders({
      Authorization: 'L402 secret',
      Connection: 'keep-alive, x-internal-hop',
      'Content-Length': '123',
      Host: 'localhost',
      'Keep-Alive': 'timeout=5',
      'Proxy-Authorization': 'secret',
      'X-Internal-Hop': '1',
      'X-Test': 'ok',
    })

    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('connection')).toBeNull()
    expect(headers.get('content-length')).toBeNull()
    expect(headers.get('host')).toBeNull()
    expect(headers.get('keep-alive')).toBeNull()
    expect(headers.get('proxy-authorization')).toBeNull()
    expect(headers.get('x-internal-hop')).toBeNull()
    expect(headers.get('x-test')).toBe('ok')
  })

  it('strips hop-by-hop response headers', () => {
    const headers = stripProxyResponseHeaders({
      Connection: 'close, x-upstream-only',
      'Content-Length': '123',
      Trailer: 'Expires',
      'Transfer-Encoding': 'chunked',
      'X-Upstream-Only': '1',
      'X-Test': 'ok',
    })

    expect(headers.get('connection')).toBeNull()
    expect(headers.get('content-length')).toBeNull()
    expect(headers.get('trailer')).toBeNull()
    expect(headers.get('transfer-encoding')).toBeNull()
    expect(headers.get('x-upstream-only')).toBeNull()
    expect(headers.get('x-test')).toBe('ok')
  })

  it('applies no-store, nosniff, and merges vary values without duplication', () => {
    const headers = appendVary(applyNoStoreHeaders(new Headers({ Vary: 'Accept-Encoding' })), 'Accept')
    appendVary(headers, 'Accept')

    expect(headers.get('cache-control')).toBe('no-store')
    expect(headers.get('pragma')).toBe('no-cache')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
    expect(headers.get('vary')).toBe('Accept-Encoding, Accept')
  })
})

describe('applySecurityHeaders', () => {
  it('sets X-Frame-Options, Referrer-Policy, and Permissions-Policy', () => {
    const headers = applySecurityHeaders(new Headers())
    expect(headers.get('x-frame-options')).toBe('DENY')
    expect(headers.get('referrer-policy')).toBe('no-referrer')
    expect(headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()')
    // Also includes nosniff from applyNoStoreHeaders
    expect(headers.get('x-content-type-options')).toBe('nosniff')
    expect(headers.get('cache-control')).toBe('no-store')
  })
})

describe('isPlausibleIp', () => {
  it('accepts valid IPv4 addresses', () => {
    expect(isPlausibleIp('192.168.1.1')).toBe(true)
    expect(isPlausibleIp('10.0.0.1')).toBe(true)
    expect(isPlausibleIp('127.0.0.1')).toBe(true)
    expect(isPlausibleIp('255.255.255.255')).toBe(true)
  })

  it('accepts valid IPv6 addresses', () => {
    expect(isPlausibleIp('::1')).toBe(true)
    expect(isPlausibleIp('2001:db8::1')).toBe(true)
    expect(isPlausibleIp('fe80::1')).toBe(true)
  })

  it('rejects non-IP strings', () => {
    expect(isPlausibleIp('')).toBe(false)
    expect(isPlausibleIp('not-an-ip')).toBe(false)
    expect(isPlausibleIp('DROP TABLE')).toBe(false)
    expect(isPlausibleIp('localhost')).toBe(false)
    expect(isPlausibleIp('<script>alert(1)</script>')).toBe(false)
  })

  it('rejects strings exceeding 45 characters', () => {
    expect(isPlausibleIp('a'.repeat(46))).toBe(false)
  })
})

describe('parseForwardedIp', () => {
  it('extracts the right-most entry from comma-separated list', () => {
    // Appending proxies (e.g. nginx $proxy_add_x_forwarded_for) put the
    // client-observed address last; the left-most entry is client-spoofable.
    expect(parseForwardedIp('192.168.1.1, 10.0.0.1')).toBe('10.0.0.1')
    expect(parseForwardedIp('  203.0.113.50 , 70.41.3.18')).toBe('70.41.3.18')
  })

  it('spoofed left-most entries cannot hide the real client IP', () => {
    // Client sent "X-Forwarded-For: 1.2.3.4"; proxy appended the real IP.
    expect(parseForwardedIp('1.2.3.4, 203.0.113.7')).toBe('203.0.113.7')
  })

  it('skips trusted proxy hops when trustedProxies is set', () => {
    const trusted = ['10.0.0.0/8', '172.16.0.1']
    // client -> 172.16.0.1 -> 10.0.0.2 -> us
    expect(parseForwardedIp('203.0.113.7, 172.16.0.1, 10.0.0.2', trusted)).toBe('203.0.113.7')
    // spoofed prefix entries are walked past
    expect(parseForwardedIp('1.2.3.4, 203.0.113.7, 10.0.0.2', trusted)).toBe('203.0.113.7')
  })

  it('falls back to the left-most entry when every hop is trusted', () => {
    expect(parseForwardedIp('10.0.0.1, 10.0.0.2', ['10.0.0.0/8'])).toBe('10.0.0.1')
  })

  it('matches trusted proxies by exact IP and IPv4 CIDR', () => {
    expect(isTrustedProxyIp('10.1.2.3', ['10.0.0.0/8'])).toBe(true)
    expect(isTrustedProxyIp('11.0.0.1', ['10.0.0.0/8'])).toBe(false)
    expect(isTrustedProxyIp('::1', ['::1'])).toBe(true)
    expect(isTrustedProxyIp('10.1.2.3', ['10.1.2.3'])).toBe(true)
    expect(isTrustedProxyIp('10.1.2.4', ['10.1.2.3'])).toBe(false)
    expect(isTrustedProxyIp('10.0.0.1', ['not-a-cidr/33'])).toBe(false)
  })

  it('returns undefined for non-IP values', () => {
    expect(parseForwardedIp('invalid-text')).toBeUndefined()
    expect(parseForwardedIp('; DROP TABLE --')).toBeUndefined()
    expect(parseForwardedIp('localhost')).toBeUndefined()
  })

  it('skips non-IP entries in a list', () => {
    expect(parseForwardedIp('garbage, 203.0.113.7')).toBe('203.0.113.7')
    expect(parseForwardedIp('203.0.113.7, garbage')).toBe('203.0.113.7')
  })

  it('returns undefined for null/undefined/empty', () => {
    expect(parseForwardedIp(null)).toBeUndefined()
    expect(parseForwardedIp(undefined)).toBeUndefined()
    expect(parseForwardedIp('')).toBeUndefined()
  })

  it('handles single valid IP', () => {
    expect(parseForwardedIp('10.0.0.1')).toBe('10.0.0.1')
    expect(parseForwardedIp('::1')).toBe('::1')
  })
})
