// src/storage/sqlite.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { sqliteStorage } from './sqlite.js'
import type { StorageBackend } from './interface.js'

describe('sqliteStorage', () => {
  let storage: StorageBackend

  afterEach(() => {
    storage?.close()
  })

  it('credits and reads balance', () => {
    storage = sqliteStorage()
    storage.credit('abc123', 500)
    expect(storage.balance('abc123')).toBe(500)

    // Accumulates
    storage.credit('abc123', 300)
    expect(storage.balance('abc123')).toBe(800)
  })

  it('returns zero for unknown hash', () => {
    storage = sqliteStorage()
    expect(storage.balance('nonexistent')).toBe(0)
  })

  it('debits when sufficient balance', () => {
    storage = sqliteStorage()
    storage.credit('abc123', 1000)

    const result = storage.debit('abc123', 400)
    expect(result).toEqual({ success: true, remaining: 600 })
    expect(storage.balance('abc123')).toBe(600)
  })

  it('rejects debit when insufficient balance', () => {
    storage = sqliteStorage()
    storage.credit('abc123', 100)

    const result = storage.debit('abc123', 200)
    expect(result).toEqual({ success: false, remaining: 100 })
    expect(storage.balance('abc123')).toBe(100)
  })

  it('stores and retrieves invoices', () => {
    storage = sqliteStorage()
    storage.storeInvoice('hash1', 'lnbc1...', 1000, 'mac1')

    const invoice = storage.getInvoice('hash1')
    expect(invoice).toBeDefined()
    expect(invoice!.paymentHash).toBe('hash1')
    expect(invoice!.bolt11).toBe('lnbc1...')
    expect(invoice!.amountSats).toBe(1000)
    expect(invoice!.macaroon).toBe('mac1')
    expect(invoice!.createdAt).toBeTruthy()
  })

  it('returns undefined for unknown invoice', () => {
    storage = sqliteStorage()
    expect(storage.getInvoice('nonexistent')).toBeUndefined()
  })

  it('is idempotent on duplicate invoice store', () => {
    storage = sqliteStorage()
    storage.storeInvoice('hash1', 'lnbc1...', 1000, 'mac1')
    storage.storeInvoice('hash1', 'lnbc2...', 2000, 'mac2')

    const invoice = storage.getInvoice('hash1')
    expect(invoice!.bolt11).toBe('lnbc1...')
    expect(invoice!.amountSats).toBe(1000)
  })
})
