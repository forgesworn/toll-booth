import { describe, expect, it } from 'vitest'
import {
  appendVary,
  applyNoStoreHeaders,
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
