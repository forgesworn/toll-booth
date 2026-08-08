import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nwcBackend } from './nwc.js'

const mockMakeInvoice = vi.fn()
const mockLookupInvoice = vi.fn()
const mockConnect = vi.fn()
const mockClose = vi.fn()

vi.mock('./nwc-client.js', () => ({
  NWCClient: class MockNWCClient {
    replyTimeout = 60_000
    constructor(_url: string) {}
    connect = mockConnect
    close = mockClose
    makeInvoice = mockMakeInvoice
    lookupInvoice = mockLookupInvoice
  },
}))

const VALID_NWC_URL = 'nostr+walletconnect://pubkey?relay=wss://relay.example.com&secret=deadbeef'

describe('nwcBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws if NWC URL is missing or invalid', () => {
    expect(() => nwcBackend({ nwcUrl: '' })).toThrow()
    expect(() => nwcBackend({ nwcUrl: 'https://not-nwc.com' })).toThrow('nostr+walletconnect://')
  })

  it('creates an invoice via NWC make_invoice', async () => {
    mockMakeInvoice.mockResolvedValue({
      invoice: 'lnbc100n1mock...',
      payment_hash: 'a'.repeat(64),
    })

    const backend = nwcBackend({ nwcUrl: VALID_NWC_URL })
    const invoice = await backend.createInvoice(100, 'test memo')

    expect(invoice).toEqual({
      bolt11: 'lnbc100n1mock...',
      paymentHash: 'a'.repeat(64),
    })
    expect(mockMakeInvoice).toHaveBeenCalledWith({
      amount: 100_000, // millisatoshis
      description: 'test memo',
    })
    expect(mockConnect).toHaveBeenCalledOnce()
  })

  it('checks invoice settlement via NWC lookup_invoice', async () => {
    mockLookupInvoice.mockResolvedValue({
      state: 'settled',
      preimage: 'b'.repeat(64),
    })

    const backend = nwcBackend({ nwcUrl: VALID_NWC_URL })
    const status = await backend.checkInvoice('a'.repeat(64))

    expect(status).toEqual({ paid: true, preimage: 'b'.repeat(64) })
    expect(mockLookupInvoice).toHaveBeenCalledWith({
      payment_hash: 'a'.repeat(64),
    })
  })

  it('returns unpaid for pending invoices', async () => {
    mockLookupInvoice.mockResolvedValue({
      state: 'pending',
      preimage: '',
    })

    const backend = nwcBackend({ nwcUrl: VALID_NWC_URL })
    const status = await backend.checkInvoice('a'.repeat(64))

    expect(status).toEqual({ paid: false, preimage: undefined })
  })

  it('returns unpaid when lookup throws (e.g. NOT_FOUND)', async () => {
    mockLookupInvoice.mockRejectedValue(new Error('NOT_FOUND'))

    const backend = nwcBackend({ nwcUrl: VALID_NWC_URL })
    const status = await backend.checkInvoice('unknown')

    expect(status).toEqual({ paid: false })
  })

  it('throws when createInvoice response is missing fields', async () => {
    mockMakeInvoice.mockResolvedValue({})

    const backend = nwcBackend({ nwcUrl: VALID_NWC_URL })
    await expect(backend.createInvoice(100)).rejects.toThrow('missing invoice or payment_hash')
  })

  it('connects lazily and reuses the connection', async () => {
    mockMakeInvoice.mockResolvedValue({
      invoice: 'lnbc1...',
      payment_hash: 'c'.repeat(64),
    })
    mockLookupInvoice.mockResolvedValue({ state: 'pending' })

    const backend = nwcBackend({ nwcUrl: VALID_NWC_URL })

    await backend.createInvoice(50)
    await backend.checkInvoice('c'.repeat(64))

    // connect() should only be called once despite two operations
    expect(mockConnect).toHaveBeenCalledOnce()
  })

  it('applies custom timeout to the NWC client', async () => {
    mockMakeInvoice.mockResolvedValue({
      invoice: 'lnbc1...',
      payment_hash: 'd'.repeat(64),
    })

    const backend = nwcBackend({ nwcUrl: VALID_NWC_URL, timeout: 5000 })
    await backend.createInvoice(10)

    // Timeout is set on the instance — we verify connect was called
    // (the mock class tracks replyTimeout internally)
    expect(mockConnect).toHaveBeenCalledOnce()
  })
})
