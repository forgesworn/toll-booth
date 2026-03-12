import { describe, it, expect, vi, beforeEach } from 'vitest'
import { lnbitsBackend } from './lnbits.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => mockFetch.mockReset())

// Valid 32-byte hex payment hash for tests
const VALID_HASH = 'a'.repeat(64)

describe('lnbitsBackend', () => {
  const backend = lnbitsBackend({
    url: 'https://legend.lnbits.com',
    apiKey: 'test-api-key',
  })

  describe('createInvoice', () => {
    it('calls POST /api/v1/payments with JSON body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payment_hash: VALID_HASH,
          payment_request: 'lnbc1500n1pw5kjhm...',
        }),
      })

      const invoice = await backend.createInvoice(100, 'test memo')

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('https://legend.lnbits.com/api/v1/payments')
      expect(opts.method).toBe('POST')
      expect(opts.headers['X-Api-Key']).toBe('test-api-key')
      expect(opts.headers['Content-Type']).toBe('application/json')
      expect(opts.signal).toBeInstanceOf(AbortSignal)

      const body = JSON.parse(opts.body)
      expect(body.out).toBe(false)
      expect(body.amount).toBe(100)
      expect(body.memo).toBe('test memo')

      expect(invoice.bolt11).toBe('lnbc1500n1pw5kjhm...')
      expect(invoice.paymentHash).toBe(VALID_HASH)
    })

    it('uses default memo when none provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payment_hash: VALID_HASH,
          payment_request: 'lnbc1500n1pw5kjhm...',
        }),
      })

      await backend.createInvoice(100)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.memo).toBe('toll-booth payment')
    })

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      })

      await expect(backend.createInvoice(100)).rejects.toThrow(/500/)
    })

    it('strips trailing slash from URL', async () => {
      const b = lnbitsBackend({
        url: 'https://legend.lnbits.com/',
        apiKey: 'key',
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ payment_hash: 'h', payment_request: 'lnbc...' }),
      })

      await b.createInvoice(1)
      expect(mockFetch.mock.calls[0][0]).toBe('https://legend.lnbits.com/api/v1/payments')
    })
  })

  describe('checkInvoice', () => {
    it('returns paid=true with preimage when settled', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          paid: true,
          preimage: 'b'.repeat(64),
        }),
      })

      const status = await backend.checkInvoice(VALID_HASH)

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe(`https://legend.lnbits.com/api/v1/payments/${VALID_HASH}`)
      expect(opts.headers['X-Api-Key']).toBe('test-api-key')
      expect(opts.signal).toBeInstanceOf(AbortSignal)
      expect(status.paid).toBe(true)
      expect(status.preimage).toBe('b'.repeat(64))
    })

    it('returns paid=false when pending', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ paid: false }),
      })

      const status = await backend.checkInvoice(VALID_HASH)
      expect(status.paid).toBe(false)
      expect(status.preimage).toBeUndefined()
    })

    it('returns paid=false on 404 (not found)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

      const status = await backend.checkInvoice(VALID_HASH)
      expect(status.paid).toBe(false)
    })

    it('throws on 401 (auth failure)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorised',
      })

      await expect(backend.checkInvoice(VALID_HASH)).rejects.toThrow(/401/)
    })

    it('throws on 500 (server error)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      })

      await expect(backend.checkInvoice(VALID_HASH)).rejects.toThrow(/500/)
    })

    it('rejects invalid payment hash', async () => {
      await expect(backend.checkInvoice('not-a-hash')).rejects.toThrow(/Invalid payment hash/)
    })
  })
})
