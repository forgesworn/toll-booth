import { describe, it, expect, vi, beforeEach } from 'vitest'
import { phoenixdBackend } from './phoenixd.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => mockFetch.mockReset())

describe('phoenixdBackend', () => {
  const backend = phoenixdBackend({
    url: 'http://localhost:9740',
    password: 'test-password',
  })

  describe('createInvoice', () => {
    it('calls POST /createinvoice with form-encoded body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          paymentHash: 'a'.repeat(64),
          serialized: 'lnbc1500n1pw5kjhm...',
        }),
      })

      const invoice = await backend.createInvoice(100, 'test memo')

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('http://localhost:9740/createinvoice')
      expect(opts.method).toBe('POST')
      expect(opts.headers['Authorization']).toMatch(/^Basic /)
      expect(opts.signal).toBeInstanceOf(AbortSignal)
      expect(opts.body.toString()).toContain('amountSat=100')
      expect(opts.body.toString()).toContain('description=test+memo')
      expect(invoice.bolt11).toBe('lnbc1500n1pw5kjhm...')
      expect(invoice.paymentHash).toBe('a'.repeat(64))
    })

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      })

      await expect(backend.createInvoice(100)).rejects.toThrow()
    })
  })

  describe('checkInvoice', () => {
    it('returns paid=true with preimage when settled', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          isPaid: true,
          preimage: 'def456',
        }),
      })

      const status = await backend.checkInvoice('a'.repeat(64))

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe(`http://localhost:9740/payments/incoming/${'a'.repeat(64)}`)
      expect(opts.signal).toBeInstanceOf(AbortSignal)
      expect(status.paid).toBe(true)
      expect(status.preimage).toBe('def456')
    })

    it('returns paid=false when pending', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ isPaid: false }),
      })

      const status = await backend.checkInvoice('a'.repeat(64))
      expect(status.paid).toBe(false)
      expect(status.preimage).toBeUndefined()
    })

    it('returns paid=false on 404 (not found)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

      const status = await backend.checkInvoice('a'.repeat(64))
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
})
