import { describe, it, expect, vi, beforeEach } from 'vitest'
import { btcpayBackend } from './btcpay.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => mockFetch.mockReset())

// Valid 32-byte hex payment hash for tests
const VALID_HASH = 'a'.repeat(64)
const BASE = 'https://btcpay.example.com/api/v1/stores/store123/lightning/BTC'

describe('btcpayBackend', () => {
  const backend = btcpayBackend({
    url: 'https://btcpay.example.com',
    storeId: 'store123',
    apiKey: 'test-api-key',
  })

  describe('createInvoice', () => {
    it('calls POST /lightning/BTC/invoices with millisatoshis and expiry', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: VALID_HASH,
          status: 'Unpaid',
          BOLT11: 'lnbc1u1ptest',
          paymentHash: VALID_HASH,
        }),
      })

      const invoice = await backend.createInvoice(100, 'test memo')

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe(`${BASE}/invoices`)
      expect(opts.method).toBe('POST')
      expect(opts.headers['Authorization']).toBe('token test-api-key')
      expect(opts.headers['Content-Type']).toBe('application/json')
      expect(opts.signal).toBeInstanceOf(AbortSignal)

      const body = JSON.parse(opts.body)
      expect(body.amount).toBe('100000')
      expect(body.description).toBe('test memo')
      expect(body.expiry).toBe(3600)

      expect(invoice.bolt11).toBe('lnbc1u1ptest')
      expect(invoice.paymentHash).toBe(VALID_HASH)
    })

    it('uses default memo when none provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ BOLT11: 'lnbc...', paymentHash: VALID_HASH }),
      })

      await backend.createInvoice(100)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.description).toBe('toll-booth payment')
    })

    it('uses the configured expiry', async () => {
      const b = btcpayBackend({ url: 'https://btcpay.example.com', storeId: 'store123', apiKey: 'key', expirySecs: 600 })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ BOLT11: 'lnbc...', paymentHash: VALID_HASH }),
      })

      await b.createInvoice(1)

      expect(JSON.parse(mockFetch.mock.calls[0][1].body).expiry).toBe(600)
    })

    it('strips trailing slash from URL and encodes the store ID', async () => {
      const b = btcpayBackend({ url: 'https://btcpay.example.com/', storeId: 'a/b', apiKey: 'key' })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ BOLT11: 'lnbc...', paymentHash: VALID_HASH }),
      })

      await b.createInvoice(1)
      expect(mockFetch.mock.calls[0][0]).toBe('https://btcpay.example.com/api/v1/stores/a%2Fb/lightning/BTC/invoices')
    })

    it('throws when the response has no valid payment hash', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ BOLT11: 'lnbc...' }),
      })

      await expect(backend.createInvoice(1)).rejects.toThrow(/payment hash/)
    })

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '{"code":"missing-permission"}',
      })

      await expect(backend.createInvoice(100)).rejects.toThrow(/403/)
    })
  })

  describe('checkInvoice', () => {
    it('returns paid=true with preimage when settled', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: VALID_HASH,
          status: 'Paid',
          paymentHash: VALID_HASH,
          preimage: 'b'.repeat(64),
        }),
      })

      const status = await backend.checkInvoice(VALID_HASH)

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe(`${BASE}/invoices/${VALID_HASH}`)
      expect(opts.headers['Authorization']).toBe('token test-api-key')
      expect(opts.signal).toBeInstanceOf(AbortSignal)
      expect(status.paid).toBe(true)
      expect(status.preimage).toBe('b'.repeat(64))
    })

    it('returns paid=false when unpaid', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'Unpaid' }),
      })

      const status = await backend.checkInvoice(VALID_HASH)
      expect(status.paid).toBe(false)
      expect(status.preimage).toBeUndefined()
    })

    it('returns paid=false when expired', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'Expired' }),
      })

      const status = await backend.checkInvoice(VALID_HASH)
      expect(status.paid).toBe(false)
    })

    it('returns paid=false when the invoice is not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => '{"code":"invoice-not-found","message":"Impossible to find a lightning invoice with this id"}',
      })

      const status = await backend.checkInvoice(VALID_HASH)
      expect(status.paid).toBe(false)
    })

    it('throws when the store has no Lightning node', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => '{"code":"lightning-not-configured","message":"The lightning node is not set up"}',
      })

      await expect(backend.checkInvoice(VALID_HASH)).rejects.toThrow(/404/)
    })

    it('throws on 401 (auth failure)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorised',
      })

      await expect(backend.checkInvoice(VALID_HASH)).rejects.toThrow(/401/)
    })

    it('throws on 503 (node unavailable)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => '{"code":"lightning-node-unavailable"}',
      })

      await expect(backend.checkInvoice(VALID_HASH)).rejects.toThrow(/503/)
    })

    it('rejects invalid payment hash', async () => {
      await expect(backend.checkInvoice('not-a-hash')).rejects.toThrow(/Invalid payment hash/)
    })
  })

  describe('sendPayment', () => {
    it('calls POST /lightning/BTC/invoices/pay and returns the preimage', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'Complete', paymentHash: VALID_HASH, preimage: 'c'.repeat(64) }),
      })

      const result = await backend.sendPayment!('lnbc1u1prefund')

      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe(`${BASE}/invoices/pay`)
      expect(opts.method).toBe('POST')
      expect(JSON.parse(opts.body)).toEqual({ BOLT11: 'lnbc1u1prefund' })
      expect(result.preimage).toBe('c'.repeat(64))
    })

    it('throws when the payment is still pending', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'Pending', paymentHash: VALID_HASH }),
      })

      await expect(backend.sendPayment!('lnbc...')).rejects.toThrow(/Pending/)
    })

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"code":"could-not-find-route"}',
      })

      await expect(backend.sendPayment!('lnbc...')).rejects.toThrow(/400/)
    })
  })
})
