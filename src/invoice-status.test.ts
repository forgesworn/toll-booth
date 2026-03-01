import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { invoiceStatus } from './invoice-status.js'
import { InvoiceStore } from './invoice-store.js'
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

function createAppWithStore(backend: LightningBackend, store: InvoiceStore) {
  const app = new Hono()
  app.get('/invoice-status/:paymentHash', invoiceStatus({
    backend,
    invoiceStore: store,
    tiers: [
      { amountSats: 1000, creditSats: 1000, label: 'Starter' },
    ],
    nwcEnabled: false,
    cashuEnabled: false,
  }))
  return app
}

describe('invoiceStatus', () => {
  describe('JSON responses (backward-compatible)', () => {
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

    it('returns 502 when backend throws', async () => {
      const backend = mockBackend()
      vi.mocked(backend.checkInvoice).mockRejectedValue(new Error('connection refused'))

      const app = createApp(backend)
      const res = await app.request('/invoice-status/ghi789')

      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'Failed to check invoice status' })
    })
  })

  describe('HTML content negotiation', () => {
    it('renders HTML payment page for browser requests', async () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const store = new InvoiceStore(db)
      store.store('abc123', 'lnbc1000n1...', 1000, 'mac_base64')

      const backend = mockBackend()
      vi.mocked(backend.checkInvoice).mockResolvedValue({ paid: false })

      const app = createAppWithStore(backend, store)
      const res = await app.request('/invoice-status/abc123', {
        headers: { 'Accept': 'text/html,application/xhtml+xml' },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('Payment Required')
      expect(html).toContain('lnbc1000n1...')
    })

    it('renders paid HTML page with preimage', async () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const store = new InvoiceStore(db)
      store.store('abc123', 'lnbc1000n1...', 1000, 'mac_base64')

      const backend = mockBackend()
      vi.mocked(backend.checkInvoice).mockResolvedValue({ paid: true, preimage: 'deadbeef' })

      const app = createAppWithStore(backend, store)
      const res = await app.request('/invoice-status/abc123', {
        headers: { 'Accept': 'text/html' },
      })

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('Payment Complete')
      expect(html).toContain('deadbeef')
    })

    it('returns 404 HTML error page for unknown payment hash', async () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const store = new InvoiceStore(db)

      const backend = mockBackend()
      const app = createAppWithStore(backend, store)
      const res = await app.request('/invoice-status/unknown', {
        headers: { 'Accept': 'text/html' },
      })

      expect(res.status).toBe(404)
      const html = await res.text()
      expect(html).toContain('Invoice Not Found')
    })

    it('returns 502 HTML error page when backend throws', async () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      const store = new InvoiceStore(db)
      store.store('abc123', 'lnbc1000n1...', 1000, 'mac_base64')

      const backend = mockBackend()
      vi.mocked(backend.checkInvoice).mockRejectedValue(new Error('fail'))

      const app = createAppWithStore(backend, store)
      const res = await app.request('/invoice-status/abc123', {
        headers: { 'Accept': 'text/html' },
      })

      expect(res.status).toBe(502)
      const html = await res.text()
      expect(html).toContain('Failed to check invoice status')
    })

    it('returns JSON even with Accept: text/html when no invoice store', async () => {
      const backend = mockBackend()
      vi.mocked(backend.checkInvoice).mockResolvedValue({ paid: false })

      const app = createApp(backend)
      const res = await app.request('/invoice-status/abc123', {
        headers: { 'Accept': 'text/html' },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ paid: false })
    })
  })
})
