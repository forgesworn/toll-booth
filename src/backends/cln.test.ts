import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clnBackend } from './cln.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => mockFetch.mockReset())

describe('clnBackend', () => {
  const backend = clnBackend({
    url: 'https://localhost:3010',
    rune: 'test-rune-token',
  })

  describe('createInvoice', () => {
    it('calls POST /v1/invoice with JSON body and Rune header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bolt11: 'lnbc1500n1ptest...',
          payment_hash: 'a'.repeat(64),
        }),
      })

      const invoice = await backend.createInvoice(100, 'test memo')

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('https://localhost:3010/v1/invoice')
      expect(opts.method).toBe('POST')
      expect(opts.headers['Rune']).toBe('test-rune-token')
      expect(opts.headers['Content-Type']).toBe('application/json')
      expect(opts.signal).toBeInstanceOf(AbortSignal)

      const body = JSON.parse(opts.body)
      expect(body.amount_msat).toBe(100_000)
      expect(body.description).toBe('test memo')
      expect(body.label).toMatch(/^toll-booth-/)

      expect(invoice.bolt11).toBe('lnbc1500n1ptest...')
      expect(invoice.paymentHash).toBe('a'.repeat(64))
    })

    it('uses default description when memo not provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bolt11: 'lnbc1000n1ptest...',
          payment_hash: 'b'.repeat(64),
        }),
      })

      await backend.createInvoice(50)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.description).toBe('toll-booth payment')
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
    it('returns paid=true with preimage when status is paid', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          invoices: [{
            status: 'paid',
            payment_preimage: 'c'.repeat(64),
          }],
        }),
      })

      const status = await backend.checkInvoice('d'.repeat(64))

      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('https://localhost:3010/v1/listinvoices?payment_hash=' + 'd'.repeat(64))
      expect(opts.signal).toBeInstanceOf(AbortSignal)
      expect(status.paid).toBe(true)
      expect(status.preimage).toBe('c'.repeat(64))
    })

    it('returns paid=false when status is unpaid', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          invoices: [{ status: 'unpaid' }],
        }),
      })

      const status = await backend.checkInvoice('e'.repeat(64))
      expect(status.paid).toBe(false)
      expect(status.preimage).toBeUndefined()
    })

    it('returns paid=false when status is expired', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          invoices: [{ status: 'expired' }],
        }),
      })

      const status = await backend.checkInvoice('f'.repeat(64))
      expect(status.paid).toBe(false)
    })

    it('returns paid=false when invoices array is empty (not found)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ invoices: [] }),
      })

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

    it('rejects invalid payment hash', async () => {
      await expect(backend.checkInvoice('not-a-hash')).rejects.toThrow(/Invalid payment hash/)
    })
  })

  describe('url normalisation', () => {
    it('strips trailing slash from base URL', async () => {
      const b = clnBackend({ url: 'https://localhost:3010/', rune: 'abc' })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bolt11: 'lnbc1test',
          payment_hash: 'a'.repeat(64),
        }),
      })

      await b.createInvoice(1)
      expect(mockFetch.mock.calls[0][0]).toBe('https://localhost:3010/v1/invoice')
    })
  })
})
