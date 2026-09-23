// src/core/hash-ip.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { deriveIpHashKey, hashIp } from './types.js'
import { createTollBooth } from './toll-booth.js'
import { handleCreateInvoice } from './create-invoice.js'
import { memoryStorage } from '../storage/memory.js'
import type { LightningBackend } from '../types.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('hashIp', () => {
  it('is not the unkeyed date-salted hash an attacker could brute-force', () => {
    const day = new Date().toISOString().slice(0, 10)
    const unkeyed = createHash('sha256').update(`${day}:203.0.113.7`).digest('hex').slice(0, 32)
    expect(hashIp('203.0.113.7')).not.toBe(unkeyed)
    expect(hashIp('203.0.113.7', deriveIpHashKey('a'.repeat(64)))).not.toBe(unkeyed)
  })

  it('is stable within a day for one key and differs between keys', () => {
    const k1 = deriveIpHashKey(randomBytes(32).toString('hex'))
    const k2 = deriveIpHashKey(randomBytes(32).toString('hex'))
    expect(hashIp('203.0.113.7', k1)).toBe(hashIp('203.0.113.7', k1))
    expect(hashIp('203.0.113.7', k1)).not.toBe(hashIp('203.0.113.7', k2))
    expect(hashIp('203.0.113.7', k1)).not.toBe(hashIp('203.0.113.8', k1))
    expect(hashIp('203.0.113.7', k1)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('uses a random per-process key by default', () => {
    expect(hashIp('203.0.113.7')).toBe(hashIp('203.0.113.7'))
  })

  it('still rotates daily', () => {
    const key = deriveIpHashKey('b'.repeat(64))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    const monday = hashIp('203.0.113.7', key)
    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'))
    expect(hashIp('203.0.113.7', key)).not.toBe(monday)
  })

  it('engine and create-invoice agree on the key, so pending limits are shared', async () => {
    const rootKey = randomBytes(32).toString('hex')
    const storage = memoryStorage()
    let n = 0
    const backend: LightningBackend = {
      createInvoice: vi.fn().mockImplementation(async () => {
        n += 1
        return { bolt11: `lnbc1mock${n}`, paymentHash: n.toString(16).padStart(64, '0') }
      }),
      checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
    }
    const created = await handleCreateInvoice(
      { backend, storage, rootKey, tiers: [], defaultAmount: 100 },
      { clientIp: '203.0.113.7' },
    )
    expect(created.success).toBe(true)

    const engine = createTollBooth({
      backend,
      storage,
      rootKey,
      upstream: 'http://localhost:1',
      pricing: { '/paid': 10 },
      invoiceRateLimit: { maxPendingPerIp: 1 },
    })
    const res = await engine.handle({ method: 'GET', path: '/paid', headers: {}, ip: '203.0.113.7' })
    expect(res.action).toBe('challenge')
    if (res.action === 'challenge') expect(res.status).toBe(429)
  })
})
