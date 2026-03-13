import { describe, it, expect } from 'vitest'
import { normalisePricing, normalisePricingTable, isTieredPricing } from './payment-rail.js'

describe('normalisePricing', () => {
  it('converts number to sats-only PriceInfo', () => {
    expect(normalisePricing(50)).toEqual({ sats: 50 })
  })

  it('passes PriceInfo through unchanged', () => {
    expect(normalisePricing({ sats: 50, usd: 2 })).toEqual({ sats: 50, usd: 2 })
  })

  it('handles usd-only PriceInfo', () => {
    expect(normalisePricing({ usd: 5 })).toEqual({ usd: 5 })
  })

  it('handles zero', () => {
    expect(normalisePricing(0)).toEqual({ sats: 0 })
  })
})

describe('normalisePricingTable', () => {
  it('normalises mixed table', () => {
    const table = {
      '/api/a': 100,
      '/api/b': { sats: 50, usd: 2 },
      '/api/c': { usd: 5 },
    }
    expect(normalisePricingTable(table)).toEqual({
      '/api/a': { sats: 100 },
      '/api/b': { sats: 50, usd: 2 },
      '/api/c': { usd: 5 },
    })
  })

  it('normalises tiered entry using default tier value', () => {
    const table = {
      '/api/a': { default: 5, premium: 42 },
    }
    expect(normalisePricingTable(table)).toEqual({
      '/api/a': { sats: 5 },
    })
  })

  it('normalises tiered entry with PriceInfo default', () => {
    const table = {
      '/api/a': { default: { sats: 5, usd: 1 }, premium: { sats: 42, usd: 8 } },
    }
    expect(normalisePricingTable(table)).toEqual({
      '/api/a': { sats: 5, usd: 1 },
    })
  })

  it('preserves flat and tiered entries in same table', () => {
    const table = {
      '/api/flat': 100,
      '/api/tiered': { default: 10, premium: 50 },
    }
    expect(normalisePricingTable(table)).toEqual({
      '/api/flat': { sats: 100 },
      '/api/tiered': { sats: 10 },
    })
  })
})

describe('isTieredPricing', () => {
  it('returns true for number-valued tier map', () => {
    expect(isTieredPricing({ default: 5, premium: 42 })).toBe(true)
  })

  it('returns true for PriceInfo-valued tier map', () => {
    expect(isTieredPricing({ default: { sats: 5, usd: 1 }, premium: { sats: 42, usd: 8 } })).toBe(true)
  })

  it('returns true for single-tier map', () => {
    expect(isTieredPricing({ default: 5 })).toBe(true)
  })

  it('returns false for number', () => {
    expect(isTieredPricing(21)).toBe(false)
  })

  it('returns false for PriceInfo with sats and usd', () => {
    expect(isTieredPricing({ sats: 21, usd: 4 })).toBe(false)
  })

  it('returns false for PriceInfo with only sats', () => {
    expect(isTieredPricing({ sats: 21 })).toBe(false)
  })
})
