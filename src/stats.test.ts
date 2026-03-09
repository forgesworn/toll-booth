// src/stats.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { StatsCollector } from './stats.js'

describe('StatsCollector', () => {
  let stats: StatsCollector

  beforeEach(() => {
    stats = new StatsCollector()
  })

  describe('recordRequest', () => {
    it('increments total and authenticated counters for paid requests', () => {
      stats.recordRequest({
        timestamp: new Date().toISOString(),
        endpoint: '/route',
        satsDeducted: 2,
        remainingBalance: 998,
        latencyMs: 50,
        authenticated: true,
      })

      const snap = stats.snapshot()
      expect(snap.requests.total).toBe(1)
      expect(snap.requests.authenticated).toBe(1)
      expect(snap.requests.freeTier).toBe(0)
    })

    it('increments total and freeTier counters for free requests', () => {
      stats.recordRequest({
        timestamp: new Date().toISOString(),
        endpoint: '/route',
        satsDeducted: 0,
        remainingBalance: 0,
        latencyMs: 30,
        authenticated: false,
      })

      const snap = stats.snapshot()
      expect(snap.requests.total).toBe(1)
      expect(snap.requests.freeTier).toBe(1)
      expect(snap.requests.authenticated).toBe(0)
    })

    it('tracks per-endpoint breakdown', () => {
      stats.recordRequest({
        timestamp: new Date().toISOString(),
        endpoint: '/route',
        satsDeducted: 2,
        remainingBalance: 996,
        latencyMs: 50,
        authenticated: true,
      })
      stats.recordRequest({
        timestamp: new Date().toISOString(),
        endpoint: '/route',
        satsDeducted: 2,
        remainingBalance: 994,
        latencyMs: 45,
        authenticated: true,
      })
      stats.recordRequest({
        timestamp: new Date().toISOString(),
        endpoint: '/isochrone',
        satsDeducted: 5,
        remainingBalance: 989,
        latencyMs: 120,
        authenticated: true,
      })

      const snap = stats.snapshot()
      expect(snap.endpoints['/route']).toEqual({ requests: 2, satsConsumed: 4 })
      expect(snap.endpoints['/isochrone']).toEqual({ requests: 1, satsConsumed: 5 })
      expect(snap.revenue.totalConsumed).toBe(9)
    })
  })

  describe('recordPayment', () => {
    it('increments invoicesPaid and totalCredited', () => {
      stats.recordPayment({
        timestamp: new Date().toISOString(),
        paymentHash: 'abc123',
        amountSats: 1000,
      })

      const snap = stats.snapshot()
      expect(snap.revenue.invoicesPaid).toBe(1)
      expect(snap.revenue.totalCredited).toBe(1000)
    })
  })

  describe('recordChallenge', () => {
    it('increments challenged counter', () => {
      stats.recordChallenge({
        timestamp: new Date().toISOString(),
        endpoint: '/route',
        amountSats: 1000,
      })
      stats.recordChallenge({
        timestamp: new Date().toISOString(),
        endpoint: '/isochrone',
        amountSats: 1000,
      })

      const snap = stats.snapshot()
      expect(snap.requests.challenged).toBe(2)
    })
  })

  describe('recordNwcPayment', () => {
    it('increments nwcPayments and totalCredited', () => {
      stats.recordNwcPayment(1000)

      const snap = stats.snapshot()
      expect(snap.revenue.nwcPayments).toBe(1)
      expect(snap.revenue.totalCredited).toBe(1000)
    })
  })

  describe('recordCashuRedemption', () => {
    it('increments cashuRedemptions and totalCredited', () => {
      stats.recordCashuRedemption(500)

      const snap = stats.snapshot()
      expect(snap.revenue.cashuRedemptions).toBe(1)
      expect(snap.revenue.totalCredited).toBe(500)
    })
  })

  describe('snapshot', () => {
    it('returns a frozen copy that does not mutate', () => {
      stats.recordRequest({
        timestamp: new Date().toISOString(),
        endpoint: '/route',
        satsDeducted: 2,
        remainingBalance: 998,
        latencyMs: 50,
        authenticated: true,
      })

      const snap1 = stats.snapshot()
      expect(snap1.requests.total).toBe(1)

      // Record another request after taking the snapshot
      stats.recordRequest({
        timestamp: new Date().toISOString(),
        endpoint: '/route',
        satsDeducted: 2,
        remainingBalance: 996,
        latencyMs: 40,
        authenticated: true,
      })

      // Original snapshot should be unchanged
      expect(snap1.requests.total).toBe(1)

      // New snapshot reflects the update
      const snap2 = stats.snapshot()
      expect(snap2.requests.total).toBe(2)
    })

    it('includes upSince timestamp', () => {
      const snap = stats.snapshot()
      expect(snap.upSince).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('starts with all zeroes', () => {
      const snap = stats.snapshot()
      expect(snap.requests).toEqual({
        total: 0,
        authenticated: 0,
        freeTier: 0,
        challenged: 0,
      })
      expect(snap.revenue).toEqual({
        invoicesPaid: 0,
        nwcPayments: 0,
        cashuRedemptions: 0,
        totalCredited: 0,
        totalConsumed: 0,
      })
      expect(snap.endpoints).toEqual({})
    })
  })

  describe('endpoint cap', () => {
    it('caps endpoint entries to prevent unbounded growth', () => {
      const stats = new StatsCollector()
      for (let i = 0; i < 1001; i++) {
        stats.recordRequest({
          timestamp: new Date().toISOString(),
          endpoint: `/route/${i}`,
          satsDeducted: 1,
          remainingBalance: 99,
          latencyMs: 10,
          authenticated: true,
        })
      }
      const snap = stats.snapshot()
      expect(Object.keys(snap.endpoints).length).toBeLessThanOrEqual(1000)
      // Total request count should still be accurate
      expect(snap.requests.total).toBe(1001)
    })
  })

  describe('mixed usage', () => {
    it('tracks a realistic session correctly', () => {
      // 3 free requests
      for (let i = 0; i < 3; i++) {
        stats.recordRequest({
          timestamp: new Date().toISOString(),
          endpoint: '/route',
          satsDeducted: 0,
          remainingBalance: 0,
          latencyMs: 30,
          authenticated: false,
        })
      }

      // 1 challenge issued
      stats.recordChallenge({
        timestamp: new Date().toISOString(),
        endpoint: '/route',
        amountSats: 1000,
      })

      // Payment settled
      stats.recordPayment({
        timestamp: new Date().toISOString(),
        paymentHash: 'abc123',
        amountSats: 1000,
      })

      // 5 paid requests across 2 endpoints
      for (let i = 0; i < 4; i++) {
        stats.recordRequest({
          timestamp: new Date().toISOString(),
          endpoint: '/route',
          satsDeducted: 2,
          remainingBalance: 1000 - (i + 1) * 2,
          latencyMs: 50,
          authenticated: true,
        })
      }
      stats.recordRequest({
        timestamp: new Date().toISOString(),
        endpoint: '/isochrone',
        satsDeducted: 5,
        remainingBalance: 987,
        latencyMs: 120,
        authenticated: true,
      })

      const snap = stats.snapshot()
      expect(snap.requests.total).toBe(8)
      expect(snap.requests.freeTier).toBe(3)
      expect(snap.requests.authenticated).toBe(5)
      expect(snap.requests.challenged).toBe(1)
      expect(snap.revenue.invoicesPaid).toBe(1)
      expect(snap.revenue.totalCredited).toBe(1000)
      expect(snap.revenue.totalConsumed).toBe(13) // 4*2 + 5
      expect(snap.endpoints['/route']).toEqual({ requests: 7, satsConsumed: 8 })
      expect(snap.endpoints['/isochrone']).toEqual({ requests: 1, satsConsumed: 5 })
    })
  })
})
