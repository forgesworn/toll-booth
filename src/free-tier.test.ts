// src/free-tier.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FreeTier, CreditFreeTier } from './free-tier.js'

describe('FreeTier', () => {
  let ft: FreeTier

  beforeEach(() => {
    ft = new FreeTier(10) // 10 req/day
  })

  it('allows requests under the limit', () => {
    expect(ft.check('1.2.3.4')).toEqual({ allowed: true, remaining: 9 })
    expect(ft.check('1.2.3.4')).toEqual({ allowed: true, remaining: 8 })
  })

  it('blocks requests over the limit', () => {
    for (let i = 0; i < 10; i++) ft.check('1.2.3.4')
    expect(ft.check('1.2.3.4')).toEqual({ allowed: false, remaining: 0 })
  })

  it('tracks IPs independently', () => {
    for (let i = 0; i < 10; i++) ft.check('1.2.3.4')
    expect(ft.check('5.6.7.8')).toEqual({ allowed: true, remaining: 9 })
  })

  it('rejects non-IP strings to prevent tracking map pollution', () => {
    expect(ft.check('not-an-ip')).toEqual({ allowed: false, remaining: 0 })
    expect(ft.check('DROP TABLE')).toEqual({ allowed: false, remaining: 0 })
    expect(ft.check('')).toEqual({ allowed: false, remaining: 0 })
    expect(ft.check('<script>')).toEqual({ allowed: false, remaining: 0 })
  })

  it('accepts valid IPv6 addresses', () => {
    expect(ft.check('::1')).toEqual({ allowed: true, remaining: 9 })
    expect(ft.check('2001:db8::1')).toEqual({ allowed: true, remaining: 9 })
  })

  it('resets after midnight UTC', () => {
    for (let i = 0; i < 10; i++) ft.check('1.2.3.4')
    expect(ft.check('1.2.3.4').allowed).toBe(false)

    // Advance date by 1 day
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + 86_400_001))
    expect(ft.check('1.2.3.4').allowed).toBe(true)
    vi.useRealTimers()
  })
})

describe('CreditFreeTier', () => {
  let ft: CreditFreeTier

  beforeEach(() => {
    ft = new CreditFreeTier(100)
  })

  it('allows requests that fit within the budget', () => {
    const result = ft.check('1.2.3.4', 10)
    expect(result).toEqual({ allowed: true, remaining: 90 })
  })

  it('allows multiple requests until budget exhausted', () => {
    ft.check('1.2.3.4', 40)
    ft.check('1.2.3.4', 40)
    const result = ft.check('1.2.3.4', 40)
    expect(result).toEqual({ allowed: false, remaining: 20 })
  })

  it('allows a request that exactly exhausts the budget', () => {
    ft.check('1.2.3.4', 50)
    const result = ft.check('1.2.3.4', 50)
    expect(result).toEqual({ allowed: true, remaining: 0 })
  })

  it('tracks IPs independently', () => {
    ft.check('1.2.3.4', 100)
    const result = ft.check('5.6.7.8', 10)
    expect(result).toEqual({ allowed: true, remaining: 90 })
  })

  it('rejects non-IP strings', () => {
    expect(ft.check('not-an-ip', 10)).toEqual({ allowed: false, remaining: 0 })
  })

  it('accepts valid IPv6 addresses', () => {
    expect(ft.check('::1', 10)).toEqual({ allowed: true, remaining: 90 })
  })

  it('resets after midnight UTC', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-14T12:00:00Z'))
    ft.check('1.2.3.4', 100)
    expect(ft.check('1.2.3.4', 1).allowed).toBe(false)
    vi.setSystemTime(new Date('2026-03-15T00:00:01Z'))
    expect(ft.check('1.2.3.4', 10)).toEqual({ allowed: true, remaining: 90 })
    vi.useRealTimers()
  })

  it('allows zero-cost requests without consuming budget', () => {
    expect(ft.check('1.2.3.4', 0)).toEqual({ allowed: true, remaining: 100 })
  })

  it('constructor rejects non-positive creditsPerDay', () => {
    expect(() => new CreditFreeTier(0)).toThrow()
    expect(() => new CreditFreeTier(-5)).toThrow()
  })

  it('refund adds credits back', () => {
    ft.check('1.2.3.4', 60)
    ft.refund('1.2.3.4', 20)
    const result = ft.check('1.2.3.4', 50)
    expect(result).toEqual({ allowed: true, remaining: 10 })
  })

  it('refund does not exceed daily budget', () => {
    ft.check('1.2.3.4', 10)
    ft.refund('1.2.3.4', 50)
    expect(ft.check('1.2.3.4', 100)).toEqual({ allowed: true, remaining: 0 })
  })
})

describe('FreeTier unified interface', () => {
  it('FreeTier.check ignores cost parameter', () => {
    const ft = new FreeTier(3)
    expect(ft.check('1.2.3.4', 999)).toEqual({ allowed: true, remaining: 2 })
    expect(ft.check('1.2.3.4', 999)).toEqual({ allowed: true, remaining: 1 })
    expect(ft.check('1.2.3.4', 999)).toEqual({ allowed: true, remaining: 0 })
    expect(ft.check('1.2.3.4', 999)).toEqual({ allowed: false, remaining: 0 })
  })
})
