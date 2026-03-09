// src/meter.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { CreditMeter } from './meter.js'

describe('CreditMeter', () => {
  let meter: CreditMeter

  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    meter = new CreditMeter(db)
  })

  describe('credit', () => {
    it('adds credit for a payment hash', () => {
      meter.credit('abc123', 1000)
      expect(meter.balance('abc123')).toBe(1000)
    })

    it('accumulates credit for same payment hash', () => {
      meter.credit('abc123', 500)
      meter.credit('abc123', 300)
      expect(meter.balance('abc123')).toBe(800)
    })

    it('credits an invoice only once with creditOnce', () => {
      expect(meter.creditOnce('hash1', 1000)).toBe(true)
      expect(meter.creditOnce('hash1', 1000)).toBe(false)
      expect(meter.balance('hash1')).toBe(1000)
    })

    it('does not re-credit after balance reaches zero', () => {
      expect(meter.creditOnce('hash2', 5)).toBe(true)
      expect(meter.debit('hash2', 5).success).toBe(true)
      expect(meter.balance('hash2')).toBe(0)
      expect(meter.creditOnce('hash2', 5)).toBe(false)
      expect(meter.balance('hash2')).toBe(0)
    })
  })

  describe('debit', () => {
    it('deducts from balance', () => {
      meter.credit('abc123', 1000)
      const result = meter.debit('abc123', 5)
      expect(result.success).toBe(true)
      expect(result.remaining).toBe(995)
    })

    it('rejects debit when insufficient balance', () => {
      meter.credit('abc123', 3)
      const result = meter.debit('abc123', 5)
      expect(result.success).toBe(false)
      expect(result.remaining).toBe(3)
    })

    it('rejects debit for unknown payment hash', () => {
      const result = meter.debit('unknown', 5)
      expect(result.success).toBe(false)
      expect(result.remaining).toBe(0)
    })
  })

  describe('balance', () => {
    it('returns 0 for unknown payment hash', () => {
      expect(meter.balance('unknown')).toBe(0)
    })
  })

  describe('isSettled', () => {
    it('returns false for unknown payment hash', () => {
      expect(meter.isSettled('unknown')).toBe(false)
    })

    it('returns true after creditOnce', () => {
      meter.creditOnce('settled1', 100)
      expect(meter.isSettled('settled1')).toBe(true)
    })

    it('returns false after credit (not creditOnce)', () => {
      meter.credit('unsettled1', 100)
      expect(meter.isSettled('unsettled1')).toBe(false)
    })
  })

  describe('unsettle', () => {
    it('allows re-crediting after rollback', () => {
      const hash = 'rollback1'
      meter.creditOnce(hash, 100)
      expect(meter.isSettled(hash)).toBe(true)
      expect(meter.balance(hash)).toBe(100)

      meter.unsettle(hash)
      expect(meter.isSettled(hash)).toBe(false)
      expect(meter.balance(hash)).toBe(0)

      // Can credit again after rollback
      expect(meter.creditOnce(hash, 200)).toBe(true)
      expect(meter.balance(hash)).toBe(200)
    })

    it('is a no-op for unknown payment hash', () => {
      // Should not throw
      meter.unsettle('nonexistent')
      expect(meter.isSettled('nonexistent')).toBe(false)
    })
  })

  describe('cleanupDrained', () => {
    it('removes zero-balance credits and their settlement records', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const meter = new CreditMeter(db)

      const hash = 'c'.repeat(64)
      meter.creditOnce(hash, 10)
      meter.debit(hash, 10) // drain to 0

      const removed = meter.cleanupDrained()
      expect(removed).toBe(1)
      expect(meter.balance(hash)).toBe(0)
      expect(meter.isSettled(hash)).toBe(false)
    })

    it('keeps credits with remaining balance', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const meter = new CreditMeter(db)

      const hash = 'd'.repeat(64)
      meter.creditOnce(hash, 10)
      meter.debit(hash, 5) // 5 remaining

      const removed = meter.cleanupDrained()
      expect(removed).toBe(0)
      expect(meter.balance(hash)).toBe(5)
    })
  })

  describe('input validation', () => {
    it('rejects negative credit amounts', () => {
      expect(() => meter.credit('hash', -100)).toThrow(RangeError)
    })

    it('rejects zero credit amounts', () => {
      expect(() => meter.credit('hash', 0)).toThrow(RangeError)
    })

    it('rejects fractional credit amounts', () => {
      expect(() => meter.credit('hash', 1.5)).toThrow(RangeError)
    })

    it('rejects negative debit amounts', () => {
      meter.credit('hash', 100)
      expect(() => meter.debit('hash', -5)).toThrow(RangeError)
    })

    it('rejects negative creditOnce amounts', () => {
      expect(() => meter.creditOnce('hash', -100)).toThrow(RangeError)
    })
  })
})
