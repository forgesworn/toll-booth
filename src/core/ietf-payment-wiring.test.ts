import { describe, it, expect } from 'vitest'
import { Booth } from '../booth.js'
import { memoryStorage } from '../storage/memory.js'
import type { LightningBackend } from '../types.js'

function mockBackend(): LightningBackend {
  return {
    async createInvoice(amountSats: number) {
      return { bolt11: `lnbc${amountSats}n1mock`, paymentHash: 'ab'.repeat(32) }
    },
    async checkInvoice() {
      return { paid: false }
    },
  }
}

describe('Booth with IETF Payment rail', () => {
  it('accepts ietfPayment config without throwing', () => {
    const booth = new Booth({
      adapter: 'express',
      backend: mockBackend(),
      pricing: { '/api': 100 },
      upstream: 'http://localhost:8080',
      storage: memoryStorage(),
      ietfPayment: { realm: 'api.example.com' },
    })
    expect(booth).toBeDefined()
    booth.close()
  })

  it('works without ietfPayment config (backward compat)', () => {
    const booth = new Booth({
      adapter: 'express',
      backend: mockBackend(),
      pricing: { '/api': 100 },
      upstream: 'http://localhost:8080',
      storage: memoryStorage(),
    })
    expect(booth).toBeDefined()
    booth.close()
  })

  it('throws if ietfPayment is set without a Lightning backend', () => {
    expect(() => new Booth({
      adapter: 'express',
      pricing: { '/api': 100 },
      upstream: 'http://localhost:8080',
      storage: memoryStorage(),
      ietfPayment: { realm: 'api.example.com' },
      xcashu: { mints: ['https://mint.example.com'] },
    })).toThrow('IETF Payment rail requires a Lightning backend')
  })

  it('accepts explicit hmacSecret in ietfPayment config', () => {
    const booth = new Booth({
      adapter: 'express',
      backend: mockBackend(),
      pricing: { '/api': 100 },
      upstream: 'http://localhost:8080',
      storage: memoryStorage(),
      ietfPayment: {
        realm: 'api.example.com',
        hmacSecret: 'c'.repeat(64),
      },
    })
    expect(booth).toBeDefined()
    booth.close()
  })
})
