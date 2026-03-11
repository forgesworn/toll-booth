// src/booth.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { Booth } from './booth.js'
import { memoryStorage } from './storage/memory.js'
import { sqliteStorage } from './storage/sqlite.js'
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
    adapter: 'hono',
    backend,
    pricing: { '/route': 2 },
    upstream: 'http://localhost:8002',
    rootKey: ROOT_KEY,
    storage: memoryStorage(),
    creditTiers: TIERS,
    ...overrides,
  })

  const app = new Hono()
  app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as any)
  app.post('/create-invoice', booth.createInvoiceHandler as any)
  if (booth.nwcPayHandler) app.post('/nwc-pay', booth.nwcPayHandler as any)
  if (booth.cashuRedeemHandler) app.post('/cashu-redeem', booth.cashuRedeemHandler as any)
  app.use('/*', booth.middleware as any)

  return { app, booth, backend, preimage, paymentHash }
}

describe('Booth', () => {
  describe('rootKey validation', () => {
    it('rejects a short rootKey', () => {
      expect(() => new Booth({
        adapter: 'hono',
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() },
        pricing: {},
        upstream: 'http://localhost',
        rootKey: 'abc',
        storage: memoryStorage(),
      })).toThrow(/64 hex characters/)
    })

    it('accepts a valid 64-char hex rootKey', () => {
      const booth = new Booth({
        adapter: 'hono',
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() },
        pricing: {},
        upstream: 'http://localhost',
        rootKey: 'a'.repeat(64),
        storage: memoryStorage(),
      })
      booth.close()
    })
  })

  describe('paymentHash validation', () => {
    it('rejects non-hex payment hash in invoice status', async () => {
      const { app, booth } = setup()
      const res = await app.request('/invoice-status/not-a-valid-hash')
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe('Invalid payment hash')
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

    // Store the invoice first
    await app.request('/route', { method: 'POST' })

    const res = await app.request(`/invoice-status/${paymentHash}`, {
      headers: { 'Accept': 'application/json' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ paid: false })

    booth.close()
  })

  it('creates invoice via POST /create-invoice', async () => {
    const { app, booth } = setup()

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
    it('pays via NWC and returns preimage', async () => {
      const { preimage } = makePreimageAndHash()
      const nwcPayInvoice = vi.fn().mockResolvedValue(preimage)
      const { app, booth } = setup({ nwcPayInvoice })

      const res = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc1000n1test...',
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.preimage).toBe(preimage)
      expect(nwcPayInvoice).toHaveBeenCalledWith('nostr+walletconnect://...', 'lnbc1000n1test...')

      booth.close()
    })

    it('does not expose /nwc-pay when adapter not provided', async () => {
      const { booth } = setup()
      expect(booth.nwcPayHandler).toBeUndefined()
      booth.close()
    })
  })

  describe('Cashu adapter', () => {
    it('redeems Cashu token and credits storage', async () => {
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
      expect(body.macaroon).toBeTruthy()
      expect(redeemCashu).toHaveBeenCalledWith('cashuA...', paymentHash)

      booth.close()
    })

    it('is idempotent on duplicate Cashu redemption', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const { app, booth, paymentHash } = setup({ redeemCashu })

      // Trigger a 402 to store the invoice
      await app.request('/route', { method: 'POST' })

      // First redemption
      await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })

      // Second redemption — should not call redeem again or double-credit
      const res2 = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })

      expect(res2.status).toBe(200)
      const body2 = await res2.json()
      expect(body2.credited).toBe(0)
      expect(redeemCashu).toHaveBeenCalledTimes(1)

      booth.close()
    })

    it('concurrent Cashu redemptions: only one wins, other gets 202', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const { app, booth, paymentHash } = setup({ redeemCashu })

      // Trigger a 402 to store the invoice
      await app.request('/route', { method: 'POST' })

      const makeOpts = () => ({
        method: 'POST' as const,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })

      // Fire two concurrent requests — only one wins claimForRedeem,
      // the other gets 202 (lease held, cannot recover yet)
      const [r1, r2] = await Promise.all([
        app.request('/cashu-redeem', makeOpts()),
        app.request('/cashu-redeem', makeOpts()),
      ])

      const statuses = [r1.status, r2.status].sort()
      expect(statuses).toEqual([200, 202])

      // Only one call to the external Cashu mint
      expect(redeemCashu).toHaveBeenCalledTimes(1)

      // The 200 response has the credited amount
      const winner = r1.status === 200 ? r1 : r2
      const winnerBody = await winner.json()
      expect(winnerBody.credited).toBe(500)

      booth.close()
    })

    it('Cashu redemption produces a token that authorises access', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const { app, booth, paymentHash } = setup({ redeemCashu })

      // Trigger a 402 to store the invoice
      const challengeRes = await app.request('/route', { method: 'POST' })
      const challengeBody = await challengeRes.json()
      const macaroon = challengeBody.macaroon

      // Redeem Cashu token
      await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })

      // Use the macaroon with 'settled' as preimage — should authorise
      const authedRes = await app.request('/route', {
        method: 'POST',
        headers: { Authorization: `L402 ${macaroon}:settled` },
      })

      // The middleware proxies upstream, but since upstream isn't running,
      // we check that the result is NOT a 402 challenge
      expect(authedRes.status).not.toBe(402)

      booth.close()
    })

    it('recoverPendingClaims retries unsettled claims on startup', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const storage = memoryStorage()

      // Simulate a crash: claim was written but never settled.
      // Use an expired lease so manual recovery can reacquire immediately.
      storage.claimForRedeem('abc123', 'cashuA...', -1)
      storage.storeInvoice('abc123', 'lnbc...', 1000, 'mac1')

      const booth = new Booth({
        adapter: 'hono',
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() },
        pricing: {},
        upstream: 'http://localhost',
        rootKey: ROOT_KEY,
        storage,
      })

      const recovered = await booth.recoverPendingClaims(redeemCashu)
      expect(recovered).toBe(1)
      expect(redeemCashu).toHaveBeenCalledWith('cashuA...', 'abc123')
      expect(storage.isSettled('abc123')).toBe(true)
      expect(storage.balance('abc123')).toBe(500)
      expect(storage.pendingClaims()).toHaveLength(0)

      booth.close()
    })

    it('recoverPendingClaims preserves claims on transient failure', async () => {
      const redeemCashu = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      const storage = memoryStorage()

      // Simulate a crash: claim was written but never settled
      // with an expired lease so recovery can attempt redeem.
      storage.claimForRedeem('abc123', 'cashuA...', -1)

      const booth = new Booth({
        adapter: 'hono',
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() },
        pricing: {},
        upstream: 'http://localhost',
        rootKey: ROOT_KEY,
        storage,
      })

      const recovered = await booth.recoverPendingClaims(redeemCashu)
      expect(recovered).toBe(0)

      // Claim is still pending — NOT erased
      expect(storage.pendingClaims()).toHaveLength(1)
      expect(storage.isSettled('abc123')).toBe(false)
      expect(storage.balance('abc123')).toBe(0)

      booth.close()
    })

    it('recoverPendingClaims skips claims with active lease', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const storage = memoryStorage()

      // Lease is active; another request/process should still own this claim.
      storage.claimForRedeem('abc123', 'cashuA...', 30_000)

      const booth = new Booth({
        adapter: 'hono',
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() },
        pricing: {},
        upstream: 'http://localhost',
        rootKey: ROOT_KEY,
        storage,
      })

      const recovered = await booth.recoverPendingClaims(redeemCashu)
      expect(recovered).toBe(0)
      expect(redeemCashu).not.toHaveBeenCalled()
      expect(storage.isSettled('abc123')).toBe(false)
      expect(storage.pendingClaims()).toHaveLength(1)

      booth.close()
    })

    it('recoverPendingClaims keeps lease alive during long-running redeem', async () => {
      vi.useFakeTimers()
      try {
        const storage = memoryStorage()
        storage.claimForRedeem('abc123', 'cashuA...', -1)

        let resolveRedeem: ((credited: number) => void) | undefined
        const redeemCashu = vi.fn().mockImplementation(
          () => new Promise<number>((resolve) => { resolveRedeem = resolve }),
        )

        const booth = new Booth({
          adapter: 'hono',
          backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() },
          pricing: {},
          upstream: 'http://localhost',
          rootKey: ROOT_KEY,
          storage,
        })

        const recoveryPromise = booth.recoverPendingClaims(redeemCashu)
        await Promise.resolve()
        expect(redeemCashu).toHaveBeenCalledTimes(1)

        // Lease renewal should keep this claim locked during long in-flight redeem.
        vi.advanceTimersByTime(31_000)
        expect(storage.tryAcquireRecoveryLease('abc123', 30_000)).toBeUndefined()

        resolveRedeem?.(500)
        const recovered = await recoveryPromise
        expect(recovered).toBe(1)
        expect(storage.isSettled('abc123')).toBe(true)
        expect(storage.balance('abc123')).toBe(500)

        booth.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it('auto-recovers pending claims when redeemCashu is provided', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const storage = memoryStorage()

      // Simulate a crash: claim was written but never settled.
      // Use an expired lease so startup auto-recovery can acquire it.
      storage.claimForRedeem('abc123', 'cashuA...', -1)

      const booth = new Booth({
        adapter: 'hono',
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() },
        pricing: {},
        upstream: 'http://localhost',
        rootKey: ROOT_KEY,
        storage,
        redeemCashu,
      })

      // Auto-recovery runs asynchronously — give it a tick
      await new Promise((r) => setTimeout(r, 10))

      expect(redeemCashu).toHaveBeenCalledWith('cashuA...', 'abc123')
      expect(storage.isSettled('abc123')).toBe(true)
      expect(storage.balance('abc123')).toBe(500)
      expect(storage.pendingClaims()).toHaveLength(0)

      booth.close()
    })

    it('startup auto-recovery skips active lease in shared sqlite storage', async () => {
      const dbPath = `/tmp/toll-booth-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
      const writer = sqliteStorage({ path: dbPath })
      writer.storeInvoice('abc123', 'lnbc...', 1000, 'mac1')
      expect(writer.claimForRedeem('abc123', 'cashuA...', 30_000)).toBe(true)

      const redeemCashu = vi.fn().mockResolvedValue(500)
      const booth = new Booth({
        adapter: 'hono',
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() },
        pricing: {},
        upstream: 'http://localhost',
        rootKey: ROOT_KEY,
        storage: sqliteStorage({ path: dbPath }),
        redeemCashu,
      })

      // Auto-recovery runs asynchronously — give it a tick
      await new Promise((r) => setTimeout(r, 10))

      expect(redeemCashu).not.toHaveBeenCalled()
      expect(writer.isSettled('abc123')).toBe(false)
      expect(writer.pendingClaims()).toHaveLength(1)

      booth.close()
      writer.close()
    })

    it('rejects unknown paymentHash that has no stored invoice', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const { app, booth } = setup({ redeemCashu })

      // Post with a valid-format but never-issued paymentHash
      const unknownHash = 'c'.repeat(64)
      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash: unknownHash }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Unknown payment hash')
      // Must never call the external mint
      expect(redeemCashu).not.toHaveBeenCalled()

      booth.close()
    })

    it('returns 202 pending when initial redeem fails (transient error)', async () => {
      const redeemCashu = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      const { app, booth, paymentHash } = setup({ redeemCashu })

      // Store the invoice
      await app.request('/route', { method: 'POST' })

      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })

      expect(res.status).toBe(202)
      const body = await res.json()
      expect(body.state).toBe('pending')
      expect(body.retryAfterMs).toBe(2000)

      booth.close()
    })

    it('client retry recovers a pending claim after lease expires', async () => {
      vi.useFakeTimers()
      try {
        const redeemCashu = vi.fn()
          .mockRejectedValueOnce(new Error('ECONNREFUSED'))
          .mockResolvedValueOnce(500)
        const { app, booth, paymentHash } = setup({ redeemCashu })

        // Store the invoice
        await app.request('/route', { method: 'POST' })

        // First attempt — mint fails, claim is pending with active lease
        const res1 = await app.request('/cashu-redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'cashuA...', paymentHash }),
        })
        expect(res1.status).toBe(202)

        // Advance past lease expiry (30s default)
        vi.advanceTimersByTime(31_000)

        // Second attempt — lease expired, recovery succeeds
        const res2 = await app.request('/cashu-redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'cashuA...', paymentHash }),
        })
        expect(res2.status).toBe(200)
        const body2 = await res2.json()
        expect(body2.credited).toBe(500)
        expect(body2.macaroon).toBeTruthy()
        expect(redeemCashu).toHaveBeenCalledTimes(2)

        booth.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it('returns 202 on retry when recovery also fails', async () => {
      vi.useFakeTimers()
      try {
        const redeemCashu = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
        const { app, booth, paymentHash } = setup({ redeemCashu })

        // Store the invoice
        await app.request('/route', { method: 'POST' })

        // First attempt — fails
        const res1 = await app.request('/cashu-redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'cashuA...', paymentHash }),
        })
        expect(res1.status).toBe(202)

        // Advance past lease expiry
        vi.advanceTimersByTime(31_000)

        // Second attempt — lease expired so recovery is attempted, but also fails
        const res2 = await app.request('/cashu-redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'cashuA...', paymentHash }),
        })
        expect(res2.status).toBe(202)
        const body2 = await res2.json()
        expect(body2.state).toBe('pending')
        expect(redeemCashu).toHaveBeenCalledTimes(2)

        booth.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it('concurrent retries while lease held: only lease holder calls redeem', async () => {
      vi.useFakeTimers()
      try {
        const redeemCashu = vi.fn()
          .mockRejectedValueOnce(new Error('ECONNREFUSED'))  // initial fail
          .mockResolvedValueOnce(500)                         // recovery succeeds
        const { app, booth, paymentHash } = setup({ redeemCashu })

        // Store the invoice
        await app.request('/route', { method: 'POST' })

        // Initial attempt fails — claim with lease
        await app.request('/cashu-redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'cashuA...', paymentHash }),
        })

        // Advance past lease expiry
        vi.advanceTimersByTime(31_000)

        // Two concurrent retries — only one acquires recovery lease
        const makeOpts = () => ({
          method: 'POST' as const,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'cashuA...', paymentHash }),
        })
        const [r1, r2] = await Promise.all([
          app.request('/cashu-redeem', makeOpts()),
          app.request('/cashu-redeem', makeOpts()),
        ])

        const statuses = [r1.status, r2.status].sort()
        expect(statuses).toEqual([200, 202])

        // Only one additional redeem call (2 total: initial fail + recovery)
        expect(redeemCashu).toHaveBeenCalledTimes(2)

        booth.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it('long-running in-flight redeem keeps lease, retry stays pending', async () => {
      vi.useFakeTimers()
      try {
        let resolveRedeem: ((credited: number) => void) | undefined
        const redeemCashu = vi.fn().mockImplementation(
          () => new Promise<number>((resolve) => { resolveRedeem = resolve }),
        )
        const { app, booth, paymentHash } = setup({ redeemCashu })

        // Store the invoice
        await app.request('/route', { method: 'POST' })

        const opts = {
          method: 'POST' as const,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'cashuA...', paymentHash }),
        }

        // First request acquires claim and starts a long-running redeem.
        const firstPromise = app.request('/cashu-redeem', opts)
        // Let the handler advance to the redeem call under fake timers.
        for (let i = 0; i < 5 && redeemCashu.mock.calls.length === 0; i++) {
          await vi.advanceTimersByTimeAsync(0)
        }
        expect(redeemCashu).toHaveBeenCalledTimes(1)

        // Move past the base lease duration; keepalive should have renewed it.
        vi.advanceTimersByTime(31_000)

        const second = await app.request('/cashu-redeem', opts)
        expect(second.status).toBe(202)
        const secondBody = await second.json()
        expect(secondBody.state).toBe('pending')
        expect(redeemCashu).toHaveBeenCalledTimes(1)

        resolveRedeem?.(500)
        const first = await firstPromise
        expect(first.status).toBe(200)
        const firstBody = await first.json()
        expect(firstBody.credited).toBe(500)

        booth.close()
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not expose /cashu-redeem when adapter not provided', async () => {
      const { booth } = setup()
      expect(booth.cashuRedeemHandler).toBeUndefined()
      booth.close()
    })
  })

  it('records stats from middleware events', async () => {
    const { app, booth } = setup()

    // Trigger a 402 challenge
    await app.request('/route', { method: 'POST' })

    const snap = booth.stats.snapshot()
    expect(snap.requests.challenged).toBe(1)

    booth.close()
  })

  it('full flow: 402 -> payment page -> create invoice -> JSON status', async () => {
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
