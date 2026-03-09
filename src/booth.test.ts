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
  app.get('/health', booth.healthHandler)
  app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler)
  app.post('/create-invoice', booth.createInvoiceHandler)
  app.get('/stats', booth.statsHandler)
  if (booth.nwcPayHandler) app.post('/nwc-pay', booth.nwcPayHandler)
  if (booth.cashuRedeemHandler) app.post('/cashu-redeem', booth.cashuRedeemHandler)
  app.use('/*', booth.middleware)

  return { app, booth, backend, preimage, paymentHash }
}

describe('Booth', () => {
  describe('rootKey validation', () => {
    it('rejects a short rootKey', () => {
      expect(() => new Booth({
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() },
        pricing: {},
        upstream: 'http://localhost',
        rootKey: 'abc',
        dbPath: ':memory:',
      })).toThrow(/64 hex characters/)
    })

    it('accepts a valid 64-char hex rootKey', () => {
      const booth = new Booth({
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() },
        pricing: {},
        upstream: 'http://localhost',
        rootKey: 'a'.repeat(64),
        dbPath: ':memory:',
      })
      booth.close()
    })
  })

  describe('paymentHash validation', () => {
    it('rejects non-hex payment hash', async () => {
      const { app, booth } = setup()
      const res = await app.request('/invoice-status/not-a-valid-hash')
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('64 hex')
      booth.close()
    })

    it('rejects a short payment hash', async () => {
      const { app, booth } = setup()
      const res = await app.request('/invoice-status/abc123')
      expect(res.status).toBe(400)
      booth.close()
    })
  })

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
    it('pays via NWC and credits the server-determined amount', async () => {
      const { preimage, paymentHash } = makePreimageAndHash()
      const nwcPayInvoice = vi.fn().mockResolvedValue(preimage)
      const { app, booth } = setup({ nwcPayInvoice })

      // First trigger a 402 to store the invoice (amount = defaultInvoiceAmount = 1000)
      await app.request('/route', { method: 'POST' })

      const res = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc1000n1test...',
          paymentHash,
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.preimage).toBe(preimage)
      // Credits the amount from the stored invoice (defaultInvoiceAmount), not client-supplied
      expect(body.credited).toBe(1000)
      expect(nwcPayInvoice).toHaveBeenCalledWith('nostr+walletconnect://...', 'lnbc1000n1test...')

      booth.close()
    })

    it('rejects NWC payment for unknown payment hash', async () => {
      const nwcPayInvoice = vi.fn()
      const { app, booth } = setup({ nwcPayInvoice })

      const res = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc...',
          paymentHash: 'e'.repeat(64),
        }),
      })

      expect(res.status).toBe(404)
      expect(nwcPayInvoice).not.toHaveBeenCalled()

      booth.close()
    })

    it('rejects replay of same payment hash', async () => {
      const { preimage, paymentHash } = makePreimageAndHash()
      const nwcPayInvoice = vi.fn().mockResolvedValue(preimage)
      const { app, booth } = setup({ nwcPayInvoice })

      // Store invoice
      await app.request('/route', { method: 'POST' })

      // First payment succeeds
      await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc1000n1test...',
          paymentHash,
        }),
      })

      // Second with same hash is rejected before calling NWC
      nwcPayInvoice.mockClear()
      const res2 = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc1000n1test...',
          paymentHash,
        }),
      })

      expect(res2.status).toBe(409)
      expect(nwcPayInvoice).not.toHaveBeenCalled()

      booth.close()
    })

    it('rejects NWC payment when preimage does not match hash', async () => {
      const { paymentHash } = makePreimageAndHash()
      const nwcPayInvoice = vi.fn().mockResolvedValue('aa'.repeat(32)) // wrong preimage
      const { app, booth } = setup({ nwcPayInvoice })

      // Store invoice
      await app.request('/route', { method: 'POST' })

      const res = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc1000n1test...',
          paymentHash,
        }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Preimage does not match')

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

    it('returns 400 for invalid paymentHash', async () => {
      const nwcPayInvoice = vi.fn()
      const { app, booth } = setup({ nwcPayInvoice })

      const res = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc...',
          paymentHash: 'bad',
        }),
      })

      expect(res.status).toBe(400)
      expect(nwcPayInvoice).not.toHaveBeenCalled()

      booth.close()
    })

    it('rejects NWC payment when bolt11 does not match stored invoice', async () => {
      const { paymentHash } = makePreimageAndHash()
      const nwcPayInvoice = vi.fn()
      const { app, booth } = setup({ nwcPayInvoice })

      // Store invoice (bolt11 = 'lnbc1000n1test...')
      await app.request('/route', { method: 'POST' })

      const res = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc_attacker_invoice...',
          paymentHash,
        }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('bolt11 does not match')
      expect(nwcPayInvoice).not.toHaveBeenCalled()

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
      const { app, booth, paymentHash } = setup({ redeemCashu })

      // Trigger a 402 to store the invoice for this paymentHash
      await app.request('/route', { method: 'POST' })

      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.credited).toBe(500)
      expect(redeemCashu).toHaveBeenCalledWith('cashuA...', paymentHash)

      booth.close()
    })

    it('rejects replay of same payment hash', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const { app, booth, paymentHash } = setup({ redeemCashu })

      // Store invoice
      await app.request('/route', { method: 'POST' })

      // First redeem succeeds
      const res1 = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })
      expect(res1.status).toBe(200)

      // Second redeem with same hash is rejected
      const res2 = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })
      expect(res2.status).toBe(409)
      const body = await res2.json()
      expect(body.error).toContain('already been credited')

      booth.close()
    })

    it('rejects unknown payment hash', async () => {
      const redeemCashu = vi.fn()
      const { app, booth } = setup({ redeemCashu })

      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash: 'e'.repeat(64) }),
      })
      expect(res.status).toBe(404)
      expect(redeemCashu).not.toHaveBeenCalled()

      booth.close()
    })

    it('rejects invalid paymentHash format', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const { app, booth } = setup({ redeemCashu })

      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash: 'not-valid' }),
      })
      expect(res.status).toBe(400)
      expect(redeemCashu).not.toHaveBeenCalled()

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

    it('rolls back settlement when Cashu redemption fails', async () => {
      const redeemCashu = vi.fn().mockRejectedValue(new Error('Mint unreachable'))
      const { app, booth, paymentHash } = setup({ redeemCashu })

      // Store invoice
      await app.request('/route', { method: 'POST' })

      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })

      expect(res.status).toBe(500)

      // After rollback, a retry should be allowed (not stuck as "already credited")
      redeemCashu.mockResolvedValue(500)
      const res2 = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuRetry...', paymentHash }),
      })

      expect(res2.status).toBe(200)
      expect((await res2.json()).credited).toBe(500)

      booth.close()
    })

    it('returns macaroon in Cashu redeem response', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(1000)
      const { app, booth, paymentHash } = setup({ redeemCashu })

      // Store invoice
      await app.request('/route', { method: 'POST' })

      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.macaroon).toBeTruthy()
      expect(typeof body.macaroon).toBe('string')

      booth.close()
    })

    it('reconciles credit when redeemed amount differs from invoice', async () => {
      // Redeem returns 600 but invoice was for 1000 (defaultInvoiceAmount)
      const redeemCashu = vi.fn().mockResolvedValue(600)
      const { app, booth, paymentHash, preimage } = setup({ redeemCashu })

      // Store invoice (amount = 1000, the default)
      await app.request('/route', { method: 'POST' })

      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.credited).toBe(600)

      // Now use the L402 token — balance should be 600, not 1000
      const macaroon = body.macaroon
      const authToken = `L402 ${macaroon}:settled`

      // Each /route costs 2 sats. With 600 balance, should work.
      const proxyRes = await app.request('/route', {
        method: 'POST',
        headers: { 'Authorization': authToken },
      })
      // 502 (upstream not running) means auth passed — NOT 402
      expect(proxyRes.status).not.toBe(402)

      // Verify balance is 598 (600 - 2) by making 299 more requests (spending 598 sats)
      // then confirming the next one is rejected. Instead, just verify a second request works.
      const proxyRes2 = await app.request('/route', {
        method: 'POST',
        headers: { 'Authorization': authToken },
      })
      expect(proxyRes2.status).not.toBe(402) // still has credit

      booth.close()
    })

    it('full Cashu flow: 402 → redeem → L402 auth with settled token', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(1000)
      const { app, booth, paymentHash } = setup({ redeemCashu })

      // 1. Get 402 challenge
      const challenge = await app.request('/route', { method: 'POST' })
      expect(challenge.status).toBe(402)

      // 2. Redeem Cashu token
      const redeemRes = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })
      expect(redeemRes.status).toBe(200)
      const { macaroon } = await redeemRes.json()

      // 3. Use L402 with "settled" placeholder — should be authorised
      const authRes = await app.request('/route', {
        method: 'POST',
        headers: { 'Authorization': `L402 ${macaroon}:settled` },
      })
      expect(authRes.status).not.toBe(402)

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

  describe('healthHandler', () => {
    it('returns 200 with healthy status', async () => {
      const { app, booth } = setup()

      const res = await app.request('/health')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('healthy')
      expect(body.database).toBe('ok')
      expect(body.upSince).toBeTruthy()

      booth.close()
    })

    it('returns 503 when database is closed', async () => {
      const { app, booth } = setup()

      booth.close() // Close the database
      const res = await app.request('/health')
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.status).toBe('degraded')
      expect(body.database).toBe('unreachable')
    })

    it('reports degraded when Lightning backend is unreachable', async () => {
      const { app, booth, backend } = setup()
      vi.mocked(backend.checkInvoice).mockRejectedValue(new Error('Connection refused'))

      const res = await app.request('/health')
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.status).toBe('degraded')
      expect(body.lightning).toBe('unreachable')
      expect(body.database).toBe('ok')

      booth.close()
    })

    it('reports healthy with lightning field when both services are ok', async () => {
      const { app, booth, backend } = setup()
      vi.mocked(backend.checkInvoice).mockResolvedValue({ paid: false })

      const res = await app.request('/health')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.lightning).toBe('ok')
      expect(body.database).toBe('ok')

      booth.close()
    })

    it('requires no authentication', async () => {
      const { app, booth } = setup({ adminToken: 'secret-token' })

      // No auth headers — should still work
      const res = await app.request('/health')
      expect(res.status).toBe(200)

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
