// src/core/create-invoice.test.ts
import { describe, it, expect, vi } from 'vitest'
import { handleCreateInvoice, type CreateInvoiceDeps } from './create-invoice.js'
import { memoryStorage } from '../storage/memory.js'
import type { LightningBackend, CreditTier } from '../types.js'

const ROOT_KEY = 'a'.repeat(64)

function mockBackend(overrides: Partial<LightningBackend> = {}): LightningBackend {
  return {
    createInvoice: vi.fn().mockResolvedValue({
      bolt11: 'lnbc1000n1mock...',
      paymentHash: 'b'.repeat(64),
    }),
    checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
    ...overrides,
  }
}

function makeDeps(overrides: Partial<CreateInvoiceDeps> = {}): CreateInvoiceDeps {
  return {
    backend: mockBackend(),
    storage: memoryStorage(),
    rootKey: ROOT_KEY,
    tiers: [],
    defaultAmount: 1000,
    ...overrides,
  }
}

describe('handleCreateInvoice', () => {
  // --- Validation ---

  it('uses defaultAmount when amountSats is omitted', async () => {
    const deps = makeDeps()
    const result = await handleCreateInvoice(deps, {})
    expect(result.success).toBe(true)
    expect(result.data?.amountSats).toBe(1000)
  })

  it('uses explicit amountSats when provided', async () => {
    const deps = makeDeps()
    const result = await handleCreateInvoice(deps, { amountSats: 500 })
    expect(result.success).toBe(true)
    expect(result.data?.amountSats).toBe(500)
  })

  it('rejects zero amountSats', async () => {
    const deps = makeDeps()
    const result = await handleCreateInvoice(deps, { amountSats: 0 })
    expect(result.success).toBe(false)
    expect(result.error).toBe('amountSats must be a positive integer')
  })

  it('rejects amountSats exceeding 21M BTC in sats', async () => {
    const deps = makeDeps()
    const result = await handleCreateInvoice(deps, { amountSats: 2_100_000_000_000_001 })
    expect(result.success).toBe(false)
    expect(result.error).toBe('amountSats must be a positive integer')
  })

  it('rejects negative amountSats', async () => {
    const deps = makeDeps()
    const result = await handleCreateInvoice(deps, { amountSats: -5 })
    expect(result.success).toBe(false)
    expect(result.error).toBe('amountSats must be a positive integer')
  })

  it('rejects non-integer amountSats', async () => {
    const deps = makeDeps()
    const result = await handleCreateInvoice(deps, { amountSats: 10.5 })
    expect(result.success).toBe(false)
    expect(result.error).toBe('amountSats must be a positive integer')
  })

  // --- Tier validation ---

  it('accepts amount matching a configured tier', async () => {
    const tiers: CreditTier[] = [
      { amountSats: 500, creditSats: 555, label: '500 sats' },
      { amountSats: 1000, creditSats: 1200, label: '1000 sats' },
    ]
    const deps = makeDeps({ tiers })
    const result = await handleCreateInvoice(deps, { amountSats: 500 })
    expect(result.success).toBe(true)
    expect(result.data?.creditSats).toBe(555)
    expect(result.data?.amountSats).toBe(500)
  })

  it('rejects amount not matching any tier', async () => {
    const tiers: CreditTier[] = [
      { amountSats: 500, creditSats: 555, label: '500 sats' },
    ]
    const deps = makeDeps({ tiers })
    const result = await handleCreateInvoice(deps, { amountSats: 750 })
    expect(result.success).toBe(false)
    expect(result.error).toBe('Invalid amount. Choose from available tiers.')
    expect(result.tiers).toEqual(tiers)
  })

  it('creditSats equals amountSats when no tiers configured', async () => {
    const deps = makeDeps({ tiers: [] })
    const result = await handleCreateInvoice(deps, { amountSats: 200 })
    expect(result.success).toBe(true)
    expect(result.data?.creditSats).toBe(200)
  })

  // --- Lightning backend ---

  it('calls backend.createInvoice with correct amount and memo', async () => {
    const backend = mockBackend()
    const deps = makeDeps({ backend })
    await handleCreateInvoice(deps, { amountSats: 500 })
    expect(backend.createInvoice).toHaveBeenCalledWith(500, 'toll-booth: 500 sats credit')
  })

  it('uses tier creditSats in the memo', async () => {
    const backend = mockBackend()
    const tiers: CreditTier[] = [{ amountSats: 500, creditSats: 555, label: '500 sats' }]
    const deps = makeDeps({ backend, tiers })
    await handleCreateInvoice(deps, { amountSats: 500 })
    expect(backend.createInvoice).toHaveBeenCalledWith(500, 'toll-booth: 555 sats credit')
  })

  it('returns bolt11 from backend', async () => {
    const deps = makeDeps()
    const result = await handleCreateInvoice(deps, {})
    expect(result.success).toBe(true)
    expect(result.data?.bolt11).toBe('lnbc1000n1mock...')
  })

  // --- Cashu-only mode ---

  it('generates synthetic paymentHash when no backend', async () => {
    const deps = makeDeps({ backend: undefined })
    const result = await handleCreateInvoice(deps, {})
    expect(result.success).toBe(true)
    expect(result.data?.paymentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.data?.bolt11).toBe('')
  })

  it('omits QR SVG when no backend (no bolt11)', async () => {
    const deps = makeDeps({ backend: undefined })
    const result = await handleCreateInvoice(deps, {})
    expect(result.success).toBe(true)
    expect(result.data?.qrSvg).toBe('')
  })

  // --- Storage ---

  it('stores invoice in storage', async () => {
    const storage = memoryStorage()
    const deps = makeDeps({ storage })
    const result = await handleCreateInvoice(deps, {})
    expect(result.success).toBe(true)

    const stored = storage.getInvoice(result.data!.paymentHash)
    expect(stored).toBeDefined()
    expect(stored!.amountSats).toBe(1000)
    expect(stored!.macaroon).toBe(result.data!.macaroon)
  })

  it('returns paymentUrl with statusToken', async () => {
    const deps = makeDeps()
    const result = await handleCreateInvoice(deps, {})
    expect(result.success).toBe(true)
    expect(result.data?.paymentUrl).toMatch(
      /^\/invoice-status\/[0-9a-f]{64}\?token=[0-9a-f]{64}$/,
    )
  })

  // --- QR code ---

  it('generates QR SVG when bolt11 is present', async () => {
    const deps = makeDeps()
    const result = await handleCreateInvoice(deps, {})
    expect(result.success).toBe(true)
    expect(result.data?.qrSvg).toContain('<svg')
  })

  // --- Error handling ---

  it('returns failure when backend throws', async () => {
    const backend = mockBackend({
      createInvoice: vi.fn().mockRejectedValue(new Error('connection refused')),
    })
    const deps = makeDeps({ backend })
    const result = await handleCreateInvoice(deps, {})
    expect(result.success).toBe(false)
    expect(result.error).toBe('Failed to create invoice')
  })
})

describe('invoice rate limiting', () => {
  it('rejects with status 429 when pending invoice count exceeds limit', async () => {
    const storage = memoryStorage()
    let counter = 0
    const backend = mockBackend({
      createInvoice: vi.fn().mockImplementation(async () => ({
        bolt11: 'lnbc...',
        paymentHash: 'a'.repeat(62) + String(counter++).padStart(2, '0'),
      })),
    })
    const deps = makeDeps({ storage, backend, maxPendingPerIp: 2 })

    await handleCreateInvoice(deps, { clientIp: '1.2.3.4' })
    await handleCreateInvoice(deps, { clientIp: '1.2.3.4' })

    const result = await handleCreateInvoice(deps, { clientIp: '1.2.3.4' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('rate limit')
    expect(result.status).toBe(429)
  })

  it('allows invoices when under limit', async () => {
    const deps = makeDeps({ maxPendingPerIp: 5 })
    const result = await handleCreateInvoice(deps, { clientIp: '1.2.3.4' })
    expect(result.success).toBe(true)
  })

  it('does not rate limit when maxPendingPerIp is not set', async () => {
    const storage = memoryStorage()
    let counter = 0
    const backend = mockBackend({
      createInvoice: vi.fn().mockImplementation(async () => ({
        bolt11: 'lnbc...',
        paymentHash: 'a'.repeat(62) + String(counter++).padStart(2, '0'),
      })),
    })
    const deps = makeDeps({ storage, backend })
    // Create many invoices — all should succeed
    for (let i = 0; i < 10; i++) {
      const result = await handleCreateInvoice(deps, { clientIp: '1.2.3.4' })
      expect(result.success).toBe(true)
    }
  })

  it('does not rate limit when clientIp is not provided', async () => {
    const storage = memoryStorage()
    let counter = 0
    const backend = mockBackend({
      createInvoice: vi.fn().mockImplementation(async () => ({
        bolt11: 'lnbc...',
        paymentHash: 'a'.repeat(62) + String(counter++).padStart(2, '0'),
      })),
    })
    const deps = makeDeps({ storage, backend, maxPendingPerIp: 1 })
    await handleCreateInvoice(deps, {})
    const result = await handleCreateInvoice(deps, {})
    expect(result.success).toBe(true)
  })
})

describe('caveats in create-invoice', () => {
  it('passes caveats to mintMacaroon', async () => {
    const deps = makeDeps()
    const result = await handleCreateInvoice(deps, { caveats: ['route = /send', 'sender = example.com'] })
    expect(result.success).toBe(true)
    // Verify by parsing the macaroon
    const { parseCaveats } = await import('../macaroon.js')
    const caveats = parseCaveats(result.data!.macaroon)
    expect(caveats.route).toBe('/send')
    expect(caveats.sender).toBe('example.com')
  })
})
