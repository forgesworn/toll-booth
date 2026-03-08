import { describe, it, expect, vi, afterEach } from 'vitest'
import { lndBackend } from './lnd.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

afterEach(() => mockFetch.mockReset())

describe('lndBackend', () => {
  it('throws if neither macaroon nor macaroonPath provided', () => {
    expect(() => lndBackend({ url: 'https://localhost:8080' })).toThrow()
  })

  it('creates an invoice', async () => {
    const rHashBase64 = Buffer.from('deadbeef01234567', 'hex').toString('base64')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        r_hash: rHashBase64,
        payment_request: 'lnbc1000n1ptest',
      }),
    })

    const backend = lndBackend({ url: 'https://localhost:8080', macaroon: 'aabbcc' })
    const invoice = await backend.createInvoice(1000, 'test memo')

    expect(invoice.bolt11).toBe('lnbc1000n1ptest')
    expect(invoice.paymentHash).toBe('deadbeef01234567')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://localhost:8080/v1/invoices',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Grpc-Metadata-macaroon': 'aabbcc',
        }),
      }),
    )
  })

  it('checks invoice status — paid', async () => {
    const preimageHex = 'cafebabe12345678'
    const preimageBase64 = Buffer.from(preimageHex, 'hex').toString('base64')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        settled: true,
        r_preimage: preimageBase64,
      }),
    })

    const backend = lndBackend({ url: 'https://localhost:8080', macaroon: 'aabbcc' })
    const status = await backend.checkInvoice('deadbeef01234567')

    expect(status.paid).toBe(true)
    expect(status.preimage).toBe(preimageHex)
  })

  it('checks invoice status — unpaid', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        settled: false,
      }),
    })

    const backend = lndBackend({ url: 'https://localhost:8080', macaroon: 'aabbcc' })
    const status = await backend.checkInvoice('deadbeef01234567')

    expect(status.paid).toBe(false)
    expect(status.preimage).toBeUndefined()
  })
})
