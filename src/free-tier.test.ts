// src/free-tier.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FreeTier } from './free-tier.js'

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
