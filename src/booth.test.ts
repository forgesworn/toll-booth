// src/booth.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { Booth } from './booth.js'
import { mintMacaroon } from './macaroon.js'
import type { LightningBackend, CreditTier } from './types.js'

const ROOT_KEY = 'a'.repeat(64)

function makePreimageAndHash(): { preimage: string; paymentHash: string } {
  const preimage = 'deadbeef'.repeat(8)
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
  return { preimage, paymentHash }
}

const TIERS: CreditTier[] = [
  { amountSats: 1000, creditSats: 1000, label: 'Starter' },
  { amountSats: 10_000, creditSats: 11_100, label: 'Pro' },
]

function setup(overrides?: Partial<{
  nwcPayInvoice: any
  redeemCashu: any
  trustProxy: boolean
  adminToken: string
}>) {
  const { preimage, paymentHash } = makePreimageAndHash()

  const backend: LightningBackend = {
    createInvoice: vi.fn().mockResolvedValue({
      bolt11: 'lnbc1000n1test...',
      paymentHash,
    }),
    checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
  }

  const booth = new Booth({
    backend,
    pricing: { '/route': 2 },
    upstream: 'http://localhost:8002',
    rootKey: ROOT_KEY,
    dbPath: ':memory:',
    creditTiers: TIERS,
    ...overrides,
  })

  const app = new Hono()
  app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler)
  app.post('/create-invoice', booth.createInvoiceHandler)
  app.get('/stats', booth.statsHandler)
  if (booth.nwcPayHandler) app.post('/nwc-pay', booth.nwcPayHandler)
  if (booth.cashuRedeemHandler) app.post('/cashu-redeem', booth.cashuRedeemHandler)
  app.use('/*', booth.middleware)

  return { app, booth, backend, preimage, paymentHash }
}

describe('Booth', () => {
  it('issues 402 with payment_url and stores invoice', async () => {
    const { app, booth, paymentHash } = setup()

    const res = await app.request('/route', { method: 'POST' })
    expect(res.status).toBe(402)

    const body = await res.json()
    expect(body.payment_url).toBe(`/invoice-status/${paymentHash}`)
    expect(body.payment_hash).toBe(paymentHash)

    booth.close()
  })

  it('serves HTML payment page at /invoice-status/:paymentHash', async () => {
    const { app, booth, paymentHash } = setup()

    // First trigger a 402 to store the invoice
    await app.request('/route', { method: 'POST' })

    // Now request the payment page
    const res = await app.request(`/invoice-status/${paymentHash}`, {
      headers: { 'Accept': 'text/html' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Payment Required')
    expect(html).toContain('lnbc1000n1test...')
    expect(html).toContain('Starter')
    expect(html).toContain('Pro')

    booth.close()
  })

  it('serves JSON invoice status at /invoice-status/:paymentHash', async () => {
    const { app, booth, backend, paymentHash } = setup()
    vi.mocked(backend.checkInvoice).mockResolvedValue({ paid: false })

    const res = await app.request(`/invoice-status/${paymentHash}`, {
      headers: { 'Accept': 'application/json' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ paid: false })

    booth.close()
  })

  it('creates invoice via POST /create-invoice', async () => {
    const { app, booth, paymentHash } = setup()

    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 10_000 }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.amount_sats).toBe(10_000)
    expect(body.credit_sats).toBe(11_100) // Pro tier

    booth.close()
  })

  it('rejects invalid tier in POST /create-invoice', async () => {
    const { app, booth } = setup()

    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 5000 }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid amount')

    booth.close()
  })

  describe('NWC adapter', () => {
    it('proxies NWC payment when adapter provided', async () => {
      const nwcPayInvoice = vi.fn().mockResolvedValue('preimage_hex')
      const { app, booth } = setup({ nwcPayInvoice })

      const res = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc...' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.preimage).toBe('preimage_hex')
      expect(nwcPayInvoice).toHaveBeenCalledWith('nostr+walletconnect://...', 'lnbc...')

      booth.close()
    })

    it('returns 400 for missing NWC params', async () => {
      const nwcPayInvoice = vi.fn()
      const { app, booth } = setup({ nwcPayInvoice })

      const res = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)

      booth.close()
    })

    it('does not expose /nwc-pay when adapter not provided', async () => {
      const { booth } = setup()
      expect(booth.nwcPayHandler).toBeUndefined()
      booth.close()
    })
  })

  describe('Cashu adapter', () => {
    it('redeems Cashu token and credits meter', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const { app, booth } = setup({ redeemCashu })

      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash: 'hash123' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.credited).toBe(500)
      expect(redeemCashu).toHaveBeenCalledWith('cashuA...', 'hash123')

      booth.close()
    })

    it('returns 400 for missing Cashu params', async () => {
      const redeemCashu = vi.fn()
      const { app, booth } = setup({ redeemCashu })

      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)

      booth.close()
    })

    it('does not expose /cashu-redeem when adapter not provided', async () => {
      const { booth } = setup()
      expect(booth.cashuRedeemHandler).toBeUndefined()
      booth.close()
    })
  })

  describe('statsHandler', () => {
    it('rejects stats by default when admin auth is not configured', async () => {
      const { app, booth } = setup()

      const res = await app.request('/stats')
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain('adminToken')

      booth.close()
    })

    it('returns stats with a valid admin token', async () => {
      const { app, booth } = setup({ adminToken: 'secret-token' })

      const res = await app.request('/stats', {
        headers: { 'Authorization': 'Bearer secret-token' },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.upSince).toBeTruthy()
      expect(body.requests.total).toBe(0)

      booth.close()
    })

    it('returns stats when X-Forwarded-For is loopback and trustProxy is enabled', async () => {
      const { app, booth } = setup({ trustProxy: true })

      const res = await app.request('/stats', {
        headers: { 'X-Forwarded-For': '127.0.0.1' },
      })
      expect(res.status).toBe(200)

      booth.close()
    })

    it('rejects stats from non-local IP when trustProxy is enabled', async () => {
      const { app, booth } = setup({ trustProxy: true })

      const res = await app.request('/stats', {
        headers: { 'X-Forwarded-For': '203.0.113.50' },
      })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain('localhost')

      booth.close()
    })

    it('records stats from middleware events', async () => {
      const { app, booth } = setup()

      // Trigger a 402 challenge
      await app.request('/route', { method: 'POST' })

      const snap = booth.stats.snapshot()
      expect(snap.requests.challenged).toBe(1)

      booth.close()
    })
  })

  it('full flow: 402 → payment page → create invoice → JSON status', async () => {
    const { app, booth, backend, paymentHash, preimage } = setup()

    // 1. Request a priced route, get 402
    const res1 = await app.request('/route', { method: 'POST' })
    expect(res1.status).toBe(402)
    const body1 = await res1.json()
    expect(body1.payment_url).toBeTruthy()

    // 2. Visit payment page (HTML)
    const res2 = await app.request(`/invoice-status/${paymentHash}`, {
      headers: { 'Accept': 'text/html' },
    })
    expect(res2.status).toBe(200)
    const html = await res2.text()
    expect(html).toContain('Payment Required')

    // 3. Create a Pro tier invoice
    const res3 = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 10_000 }),
    })
    expect(res3.status).toBe(200)

    // 4. Check JSON status
    const res4 = await app.request(`/invoice-status/${paymentHash}`)
    expect(res4.status).toBe(200)
    const body4 = await res4.json()
    expect(body4.paid).toBe(false)

    // 5. Simulate payment completion
    vi.mocked(backend.checkInvoice).mockResolvedValue({ paid: true, preimage })

    const res5 = await app.request(`/invoice-status/${paymentHash}`, {
      headers: { 'Accept': 'text/html' },
    })
    const html5 = await res5.text()
    expect(html5).toContain('Payment Complete')
    expect(html5).toContain(preimage)

    booth.close()
  })
})
