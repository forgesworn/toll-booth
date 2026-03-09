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

  describe('claim', () => {
    it('returns true on first claim', () => {
      expect(meter.claim('claim1')).toBe(true)
    })

    it('returns false on duplicate claim', () => {
      meter.claim('claim2')
      expect(meter.claim('claim2')).toBe(false)
    })

    it('marks as settled without crediting', () => {
      meter.claim('claim3')
      expect(meter.isSettled('claim3')).toBe(true)
      expect(meter.balance('claim3')).toBe(0)
    })

    it('allows credit after claim', () => {
      meter.claim('claim4')
      meter.credit('claim4', 500)
      expect(meter.balance('claim4')).toBe(500)
    })

    it('allows retry after unsettle', () => {
      meter.claim('claim5')
      meter.unsettle('claim5')
      expect(meter.claim('claim5')).toBe(true)
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
    it('removes zero-balance credits but preserves settlement tombstones', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const meter = new CreditMeter(db)

      const hash = 'c'.repeat(64)
      meter.creditOnce(hash, 10)
      meter.debit(hash, 10) // drain to 0

      const removed = meter.cleanupDrained()
      expect(removed).toBe(1)
      expect(meter.balance(hash)).toBe(0)
      // Tombstone must survive — prevents replay of spent L402 tokens
      expect(meter.isSettled(hash)).toBe(true)
      // Replayed creditOnce must still be rejected
      expect(meter.creditOnce(hash, 10)).toBe(false)
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

    it('prevents replay attack: spent token cannot re-credit after cleanup', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const meter = new CreditMeter(db)

      const hash = 'e'.repeat(64)
      // Simulate full lifecycle: credit, spend, cleanup
      meter.creditOnce(hash, 100)
      meter.debit(hash, 100)
      expect(meter.balance(hash)).toBe(0)

      meter.cleanupDrained()

      // Attacker replays the same macaroon+preimage — creditOnce must reject
      expect(meter.creditOnce(hash, 100)).toBe(false)
      expect(meter.balance(hash)).toBe(0)
    })
  })

  describe('recordRedemption + settleRedemption', () => {
    it('records redeemed amount and settles atomically', () => {
      const hash = 'redeem1'
      meter.claim(hash)
      meter.recordRedemption(hash, 500)
      meter.settleRedemption(hash, 500)
      expect(meter.balance(hash)).toBe(500)
      expect(meter.isSettled(hash)).toBe(true)
    })

    it('settleRedemption is idempotent (safe to replay)', () => {
      const hash = 'redeem2'
      meter.claim(hash)
      meter.recordRedemption(hash, 300)
      meter.settleRedemption(hash, 300)
      meter.settleRedemption(hash, 300) // replay
      expect(meter.balance(hash)).toBe(300) // not doubled
    })
  })

  describe('recoverPendingRedemptions', () => {
    it('recovers credit after simulated crash (recorded but not settled)', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')

      // Simulate: claim + recordRedemption succeeded, then "crash" before settle
      const meter1 = new CreditMeter(db)
      meter1.claim('crash1')
      meter1.recordRedemption('crash1', 750)
      // meter1 "crashes" here — settleRedemption never called

      // New meter instance on same DB (simulating restart)
      const meter2 = new CreditMeter(db)
      const recovered = meter2.recoverPendingRedemptions()
      expect(recovered).toBe(1)
      expect(meter2.balance('crash1')).toBe(750)
    })

    it('does not double-credit already settled redemptions', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')

      const meter1 = new CreditMeter(db)
      meter1.claim('ok1')
      meter1.recordRedemption('ok1', 500)
      meter1.settleRedemption('ok1', 500)

      const meter2 = new CreditMeter(db)
      const recovered = meter2.recoverPendingRedemptions()
      expect(recovered).toBe(0)
      expect(meter2.balance('ok1')).toBe(500) // unchanged
    })

    it('skips claim-only rows (no redeemed amount)', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')

      const meter1 = new CreditMeter(db)
      meter1.claim('pending1') // claim but redeem never completed

      const meter2 = new CreditMeter(db)
      const recovered = meter2.recoverPendingRedemptions()
      expect(recovered).toBe(0)
      expect(meter2.balance('pending1')).toBe(0)
    })

    it('skips non-Cashu settlements (creditOnce path)', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')

      const meter1 = new CreditMeter(db)
      meter1.creditOnce('lightning1', 1000) // NWC/Lightning path

      const meter2 = new CreditMeter(db)
      const recovered = meter2.recoverPendingRedemptions()
      expect(recovered).toBe(0)
      expect(meter2.balance('lightning1')).toBe(1000) // unchanged
    })
  })

  describe('cleanupStaleClaims', () => {
    it('removes old claims without redeemed amount', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const meter = new CreditMeter(db)

      meter.claim('stale1')
      // Backdate the claim to make it stale
      db.prepare(
        "UPDATE settled_invoices SET settled_at = datetime('now', '-2 hours') WHERE payment_hash = 'stale1'"
      ).run()

      const removed = meter.cleanupStaleClaims(3600) // 1 hour threshold
      expect(removed).toBe(1)
      expect(meter.isSettled('stale1')).toBe(false)
      // Can be claimed again
      expect(meter.claim('stale1')).toBe(true)
    })

    it('does not remove claims with redeemed amount', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const meter = new CreditMeter(db)

      meter.claim('redeemed1')
      meter.recordRedemption('redeemed1', 500)
      db.prepare(
        "UPDATE settled_invoices SET settled_at = datetime('now', '-2 hours') WHERE payment_hash = 'redeemed1'"
      ).run()

      const removed = meter.cleanupStaleClaims(3600)
      expect(removed).toBe(0)
      expect(meter.isSettled('redeemed1')).toBe(true)
    })

    it('does not remove recent claims', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const meter = new CreditMeter(db)

      meter.claim('fresh1')
      const removed = meter.cleanupStaleClaims(3600)
      expect(removed).toBe(0)
      expect(meter.isSettled('fresh1')).toBe(true)
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
