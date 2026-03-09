// src/create-invoice.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { createInvoiceHandler } from './create-invoice.js'
import { InvoiceStore } from './invoice-store.js'
import type { LightningBackend, CreditTier } from './types.js'

const ROOT_KEY = 'a'.repeat(64)

const TIERS: CreditTier[] = [
  { amountSats: 1000, creditSats: 1000, label: 'Starter' },
  { amountSats: 10_000, creditSats: 11_100, label: 'Pro' },
  { amountSats: 100_000, creditSats: 125_000, label: 'Business' },
]

function setup(tiers: CreditTier[] = TIERS) {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  const invoiceStore = new InvoiceStore(db)

  const backend: LightningBackend = {
    createInvoice: vi.fn().mockResolvedValue({
      bolt11: 'lnbc1000n1test...',
      paymentHash: 'b'.repeat(64),
    }),
    checkInvoice: vi.fn(),
  }

  const app = new Hono()
  app.post('/create-invoice', createInvoiceHandler({
    backend,
    invoiceStore,
    rootKey: ROOT_KEY,
    tiers,
    defaultAmount: 1000,
  }))

  return { app, backend, invoiceStore }
}

describe('createInvoiceHandler', () => {
  it('creates an invoice for a valid tier', async () => {
    const { app, backend, invoiceStore } = setup()

    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 10_000 }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bolt11).toBe('lnbc1000n1test...')
    expect(body.payment_hash).toBe('b'.repeat(64))
    expect(body.amount_sats).toBe(10_000)
    expect(body.credit_sats).toBe(11_100) // Pro tier with bonus
    expect(body.macaroon).toBeTruthy()
    expect(body.payment_url).toBe(`/invoice-status/${'b'.repeat(64)}`)
    expect(body.qr_svg).toContain('<svg')

    // Verify stored
    const stored = invoiceStore.get('b'.repeat(64))
    expect(stored).toBeDefined()
    expect(stored!.amountSats).toBe(11_100) // stored with creditSats

    // Verify backend was called with payment amount (not credit amount)
    expect(backend.createInvoice).toHaveBeenCalledWith(10_000, 'toll-booth: 11100 sats credit')
  })

  it('rejects invalid tier amount', async () => {
    const { app } = setup()

    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 5000 }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid amount')
    expect(body.tiers).toHaveLength(3)
  })

  it('uses default amount when no amountSats provided', async () => {
    const { app, backend } = setup()

    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.amount_sats).toBe(1000) // Starter tier (matches default)
  })

  it('accepts any amount when no tiers configured', async () => {
    const { app } = setup([])

    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 7777 }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.amount_sats).toBe(7777)
    expect(body.credit_sats).toBe(7777)
  })

  it('rejects zero amount when no tiers configured', async () => {
    const { app } = setup([])
    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 0 }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('positive integer')
  })

  it('rejects negative amount when no tiers configured', async () => {
    const { app } = setup([])
    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: -100 }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects non-integer amount when no tiers configured', async () => {
    const { app } = setup([])
    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 10.5 }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 500 on backend failure', async () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const invoiceStore = new InvoiceStore(db)

    const backend: LightningBackend = {
      createInvoice: vi.fn().mockRejectedValue(new Error('backend down')),
      checkInvoice: vi.fn(),
    }

    const app = new Hono()
    app.post('/create-invoice', createInvoiceHandler({
      backend,
      invoiceStore,
      rootKey: ROOT_KEY,
      tiers: TIERS,
      defaultAmount: 1000,
    }))

    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 1000 }),
    })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Failed to create invoice')
  })
})
