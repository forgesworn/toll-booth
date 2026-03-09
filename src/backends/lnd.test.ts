// src/backends/lnd.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { lndBackend } from './lnd.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => mockFetch.mockReset())

describe('lndBackend', () => {
  const backend = lndBackend({
    url: 'https://localhost:8080',
    macaroon: 'abcdef1234567890',
  })

  describe('createInvoice', () => {
    it('calls POST /v1/invoices with JSON body and macaroon header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          r_hash: Buffer.from('a'.repeat(64), 'hex').toString('base64'),
          payment_request: 'lnbc1500n1ptest...',
        }),
      })

      const invoice = await backend.createInvoice(100, 'test memo')

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('https://localhost:8080/v1/invoices')
      expect(opts.method).toBe('POST')
      expect(opts.headers['Grpc-Metadata-macaroon']).toBe('abcdef1234567890')
      expect(opts.headers['Content-Type']).toBe('application/json')

      const body = JSON.parse(opts.body)
      expect(body.value).toBe('100')
      expect(body.memo).toBe('test memo')

      expect(invoice.bolt11).toBe('lnbc1500n1ptest...')
      expect(invoice.paymentHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('omits memo when not provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          r_hash: Buffer.from('b'.repeat(64), 'hex').toString('base64'),
          payment_request: 'lnbc1000n1ptest...',
        }),
      })

      await backend.createInvoice(50)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.memo).toBeUndefined()
    })

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      })

      await expect(backend.createInvoice(100)).rejects.toThrow(/500/)
    })
  })

  describe('checkInvoice', () => {
    it('returns paid=true with preimage when settled', async () => {
      const preimageBytes = Buffer.from('c'.repeat(64), 'hex')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          state: 'SETTLED',
          r_preimage: preimageBytes.toString('base64'),
        }),
      })

      const status = await backend.checkInvoice('d'.repeat(64))

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://localhost:8080/v1/invoice/' + 'd'.repeat(64))
      expect(status.paid).toBe(true)
      expect(status.preimage).toBe('c'.repeat(64))
    })

    it('returns paid=false when OPEN', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ state: 'OPEN' }),
      })

      const status = await backend.checkInvoice('e'.repeat(64))
      expect(status.paid).toBe(false)
      expect(status.preimage).toBeUndefined()
    })

    it('returns paid=false when CANCELED', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ state: 'CANCELED' }),
      })

      const status = await backend.checkInvoice('f'.repeat(64))
      expect(status.paid).toBe(false)
    })

    it('returns paid=false on 404 (not found)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

      const status = await backend.checkInvoice('0'.repeat(64))
      expect(status.paid).toBe(false)
    })

    it('throws on 401 (auth failure)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      })

      await expect(backend.checkInvoice('a'.repeat(64))).rejects.toThrow(/401/)
    })

    it('throws on 500 (server error)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      })

      await expect(backend.checkInvoice('a'.repeat(64))).rejects.toThrow(/500/)
    })
  })

  describe('url normalisation', () => {
    it('strips trailing slash from base URL', async () => {
      const b = lndBackend({ url: 'https://localhost:8080/', macaroon: 'abc' })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          r_hash: Buffer.from('a'.repeat(64), 'hex').toString('base64'),
          payment_request: 'lnbc1test',
        }),
      })

      await b.createInvoice(1)
      expect(mockFetch.mock.calls[0][0]).toBe('https://localhost:8080/v1/invoices')
    })
  })
})
