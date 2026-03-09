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
})
