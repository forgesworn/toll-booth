import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { invoiceStatus } from './invoice-status.js'
import type { LightningBackend } from './types.js'

function mockBackend(): LightningBackend {
  return {
    createInvoice: vi.fn(),
    checkInvoice: vi.fn(),
  }
}

function createApp(backend: LightningBackend) {
  const app = new Hono()
  app.get('/invoice-status/:paymentHash', invoiceStatus(backend))
  return app
}

describe('invoiceStatus', () => {
  it('returns { paid: false } for an unpaid invoice', async () => {
    const backend = mockBackend()
    vi.mocked(backend.checkInvoice).mockResolvedValue({ paid: false })

    const app = createApp(backend)
    const res = await app.request('/invoice-status/abc123')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ paid: false })
    expect(backend.checkInvoice).toHaveBeenCalledWith('abc123')
  })

  it('returns { paid: true, preimage } for a settled invoice', async () => {
    const backend = mockBackend()
    vi.mocked(backend.checkInvoice).mockResolvedValue({ paid: true, preimage: 'deadbeef' })

    const app = createApp(backend)
    const res = await app.request('/invoice-status/def456')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ paid: true, preimage: 'deadbeef' })
    expect(backend.checkInvoice).toHaveBeenCalledWith('def456')
  })
})
