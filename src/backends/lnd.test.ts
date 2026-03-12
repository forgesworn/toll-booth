import { describe, it, expect, vi, afterEach } from 'vitest'
import { lndBackend } from './lnd.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

afterEach(() => mockFetch.mockReset())

// Valid 32-byte hex payment hash for tests
const VALID_HASH = 'a'.repeat(64)
const VALID_HASH_BYTES = Buffer.from(VALID_HASH, 'hex')
const VALID_HASH_B64 = VALID_HASH_BYTES.toString('base64')

describe('lndBackend', () => {
  it('throws if neither macaroon nor macaroonPath provided', () => {
    expect(() => lndBackend({ url: 'https://localhost:8080' })).toThrow()
  })

  it('creates an invoice', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        r_hash: VALID_HASH_B64,
        payment_request: 'lnbc1000n1ptest',
      }),
    })

    const backend = lndBackend({ url: 'https://localhost:8080', macaroon: 'aabbcc' })
    const invoice = await backend.createInvoice(1000, 'test memo')

    expect(invoice.bolt11).toBe('lnbc1000n1ptest')
    expect(invoice.paymentHash).toBe(VALID_HASH)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://localhost:8080/v1/invoices',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Grpc-Metadata-macaroon': 'aabbcc',
        }),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('checks invoice status - paid', async () => {
    const preimageHex = 'b'.repeat(64)
    const preimageBase64 = Buffer.from(preimageHex, 'hex').toString('base64')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        settled: true,
        r_preimage: preimageBase64,
      }),
    })

    const backend = lndBackend({ url: 'https://localhost:8080', macaroon: 'aabbcc' })
    const status = await backend.checkInvoice(VALID_HASH)

    expect(mockFetch).toHaveBeenCalledWith(
      `https://localhost:8080/v1/invoice/${VALID_HASH}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          'Grpc-Metadata-macaroon': 'aabbcc',
        }),
        signal: expect.any(AbortSignal),
      }),
    )
    expect(status.paid).toBe(true)
    expect(status.preimage).toBe(preimageHex)
  })

  it('checks invoice status - unpaid', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        settled: false,
      }),
    })

    const backend = lndBackend({ url: 'https://localhost:8080', macaroon: 'aabbcc' })
    const status = await backend.checkInvoice(VALID_HASH)

    expect(status.paid).toBe(false)
    expect(status.preimage).toBeUndefined()
  })

  it('rejects invalid payment hash', async () => {
    const backend = lndBackend({ url: 'https://localhost:8080', macaroon: 'aabbcc' })
    await expect(backend.checkInvoice('not-a-hash')).rejects.toThrow(/Invalid payment hash/)
  })
})
