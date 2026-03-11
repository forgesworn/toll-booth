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

  it('settle returns true on first call, false on subsequent', () => {
    storage = sqliteStorage()
    expect(storage.settle('hash1')).toBe(true)
    expect(storage.settle('hash1')).toBe(false)
    expect(storage.settle('hash1')).toBe(false)
  })

  it('isSettled reflects settlement state', () => {
    storage = sqliteStorage()
    expect(storage.isSettled('hash1')).toBe(false)
    storage.settle('hash1')
    expect(storage.isSettled('hash1')).toBe(true)
  })

  it('settleWithCredit atomically settles and credits', () => {
    storage = sqliteStorage()
    expect(storage.settleWithCredit('hash1', 500)).toBe(true)
    expect(storage.isSettled('hash1')).toBe(true)
    expect(storage.balance('hash1')).toBe(500)
  })

  it('settleWithCredit rejects if already settled (no double credit)', () => {
    storage = sqliteStorage()
    expect(storage.settleWithCredit('hash1', 500)).toBe(true)
    expect(storage.settleWithCredit('hash1', 500)).toBe(false)
    expect(storage.balance('hash1')).toBe(500) // not 1000
  })

  it('claimForRedeem returns true on first call, false on duplicate', () => {
    storage = sqliteStorage()
    expect(storage.claimForRedeem('hash1', 'cashuA...')).toBe(true)
    expect(storage.claimForRedeem('hash1', 'cashuA...')).toBe(false)
  })

  it('claimForRedeem rejects if already settled', () => {
    storage = sqliteStorage()
    storage.settle('hash1')
    expect(storage.claimForRedeem('hash1', 'cashuA...')).toBe(false)
  })

  it('tryAcquireRecoveryLease does not acquire while lease is active', () => {
    storage = sqliteStorage()
    expect(storage.claimForRedeem('hash1', 'tokenA', 30_000)).toBe(true)
    expect(storage.tryAcquireRecoveryLease('hash1', 30_000)).toBeUndefined()
  })

  it('tryAcquireRecoveryLease acquires when lease is expired', () => {
    storage = sqliteStorage()
    expect(storage.claimForRedeem('hash1', 'tokenA', -1)).toBe(true)

    const claim = storage.tryAcquireRecoveryLease('hash1', 30_000)
    expect(claim).toBeDefined()
    expect(claim!.paymentHash).toBe('hash1')
    expect(claim!.token).toBe('tokenA')
  })

  it('extendRecoveryLease extends while lease is active', () => {
    storage = sqliteStorage()
    expect(storage.claimForRedeem('hash1', 'tokenA', 30_000)).toBe(true)
    expect(storage.extendRecoveryLease('hash1', 30_000)).toBe(true)
  })

  it('extendRecoveryLease returns false when lease is expired', () => {
    storage = sqliteStorage()
    expect(storage.claimForRedeem('hash1', 'tokenA', -1)).toBe(true)
    expect(storage.extendRecoveryLease('hash1', 30_000)).toBe(false)
  })

  it('pendingClaims returns unsettled claims', () => {
    storage = sqliteStorage()
    storage.claimForRedeem('hash1', 'tokenA')
    storage.claimForRedeem('hash2', 'tokenB')

    // Settle hash1
    storage.settleWithCredit('hash1', 100)

    const pending = storage.pendingClaims()
    expect(pending).toHaveLength(1)
    expect(pending[0].paymentHash).toBe('hash2')
    expect(pending[0].token).toBe('tokenB')
  })

  it('settleWithCredit clears the claim row', () => {
    storage = sqliteStorage()
    storage.claimForRedeem('hash1', 'tokenA')
    expect(storage.pendingClaims()).toHaveLength(1)

    storage.settleWithCredit('hash1', 500)
    expect(storage.pendingClaims()).toHaveLength(0)
  })
})
