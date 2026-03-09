// src/invoice-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { InvoiceStore } from './invoice-store.js'
import { CreditMeter } from './meter.js'

describe('InvoiceStore', () => {
  let store: InvoiceStore

  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    store = new InvoiceStore(db)
  })

  it('stores and retrieves an invoice', () => {
    store.store('abc123', 'lnbc100n1...', 1000, 'mac_base64')
    const inv = store.get('abc123')
    expect(inv).toBeDefined()
    expect(inv!.paymentHash).toBe('abc123')
    expect(inv!.bolt11).toBe('lnbc100n1...')
    expect(inv!.amountSats).toBe(1000)
    expect(inv!.macaroon).toBe('mac_base64')
    expect(inv!.createdAt).toBeTruthy()
  })

  it('returns undefined for unknown payment hash', () => {
    expect(store.get('unknown')).toBeUndefined()
  })

  it('ignores duplicate inserts (INSERT OR IGNORE)', () => {
    store.store('abc123', 'lnbc100n1...', 1000, 'mac1')
    store.store('abc123', 'lnbc200n1...', 2000, 'mac2')
    const inv = store.get('abc123')
    expect(inv!.amountSats).toBe(1000) // first insert wins
    expect(inv!.macaroon).toBe('mac1')
  })

  it('removes invoices older than the specified age', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new InvoiceStore(db)

    store.store('a'.repeat(64), 'lnbc...', 1000, 'mac...')

    // Manually backdate the invoice
    db.prepare("UPDATE invoices SET created_at = datetime('now', '-2 hours')").run()

    const removed = store.cleanup(3600) // 1 hour
    expect(removed).toBe(1)
    expect(store.get('a'.repeat(64))).toBeUndefined()
  })

  it('keeps invoices newer than the specified age', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new InvoiceStore(db)

    store.store('a'.repeat(64), 'lnbc...', 1000, 'mac...')

    const removed = store.cleanup(3600)
    expect(removed).toBe(0)
    expect(store.get('a'.repeat(64))).toBeDefined()
  })

  it('shares the same database with CreditMeter', () => {
    // Verify both tables can coexist on the same DB
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const meter = new CreditMeter(db)
    const invoiceStore = new InvoiceStore(db)

    meter.credit('hash1', 500)
    invoiceStore.store('hash1', 'lnbc...', 500, 'mac_base64')

    expect(meter.balance('hash1')).toBe(500)
    expect(invoiceStore.get('hash1')!.amountSats).toBe(500)
  })
})
