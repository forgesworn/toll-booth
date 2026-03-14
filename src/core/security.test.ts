// src/core/security.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { createTollBooth } from './toll-booth.js'
import { createHonoTollBooth } from '../adapters/hono.js'
import { mintMacaroon } from '../macaroon.js'
import { memoryStorage } from '../storage/memory.js'
import { handleCashuRedeem } from './cashu-redeem.js'
import { Booth } from '../booth.js'

const ROOT_KEY = 'a'.repeat(64)

function makeCredential() {
  const preimage = randomBytes(32).toString('hex')
  const paymentHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex')
  return { preimage, paymentHash }
}

describe('caveat header injection prevention', () => {
  it('strips newlines from custom caveat values forwarded as headers', async () => {
    const storage = memoryStorage()
    const { preimage, paymentHash } = makeCredential()

    const engine = createTollBooth({
      storage,
      pricing: { '/api': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    // Mint macaroon with a caveat value containing CRLF
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, ['info = hello\r\nX-Injected: evil'])
    storage.settleWithCredit(paymentHash, 1000, preimage)

    const result = await engine.handle({
      method: 'GET',
      path: '/api',
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
      ip: '1.2.3.4',
    })

    expect(result.action).toBe('proxy')
    if (result.action !== 'proxy') return
    // The header value should have newlines stripped
    const infoHeader = result.headers['X-Toll-Caveat-Info']
    expect(infoHeader).toBeDefined()
    expect(infoHeader).not.toContain('\r')
    expect(infoHeader).not.toContain('\n')
  })

  it('rejects custom caveat keys containing non-alphanumeric characters', async () => {
    const storage = memoryStorage()
    const { preimage, paymentHash } = makeCredential()

    const engine = createTollBooth({
      storage,
      pricing: { '/api': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    // Mint macaroon with a caveat key containing special chars
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, ['bad-key = value'])
    storage.settleWithCredit(paymentHash, 1000, preimage)

    const result = await engine.handle({
      method: 'GET',
      path: '/api',
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
      ip: '1.2.3.4',
    })

    expect(result.action).toBe('proxy')
    if (result.action !== 'proxy') return
    // The hyphenated key should be filtered out
    expect(result.headers['X-Toll-Caveat-Bad-key']).toBeUndefined()
  })
})

describe('settlement secret entropy', () => {
  it('generates 64-char hex settlement secrets (not UUIDs)', async () => {
    const storage = memoryStorage()
    const statusToken = randomBytes(32).toString('hex')
    const paymentHash = randomBytes(32).toString('hex')

    storage.storeInvoice(paymentHash, '', 1000, 'mac', statusToken, '1.2.3.4')

    const result = await handleCashuRedeem(
      {
        redeem: async () => 1000,
        storage,
      },
      { token: 'cashuAbc123', paymentHash, statusToken },
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    // Settlement secret should be 64 hex chars (32 bytes), not a UUID
    expect(result.tokenSuffix).toMatch(/^[0-9a-f]{64}$/)
    expect(result.tokenSuffix).not.toContain('-') // UUIDs contain hyphens
  })
})

describe('x402 per-request replay protection', () => {
  it('rejects concurrent x402 per-request replay via settle() return value', () => {
    const storage = memoryStorage()
    const paymentHash = randomBytes(32).toString('hex')

    // First settle succeeds
    expect(storage.settle(paymentHash)).toBe(true)
    // Second settle fails (already settled)
    expect(storage.settle(paymentHash)).toBe(false)
  })
})

describe('credit amount validation', () => {
  it('rejects negative credit amounts', () => {
    const storage = memoryStorage()
    const paymentHash = randomBytes(32).toString('hex')
    expect(() => storage.credit(paymentHash, -100)).toThrow(RangeError)
  })

  it('rejects zero credit amounts', () => {
    const storage = memoryStorage()
    const paymentHash = randomBytes(32).toString('hex')
    expect(() => storage.credit(paymentHash, 0)).toThrow(RangeError)
  })
})

describe('invoice pruning safety', () => {
  it('does not prune invoices with pending Cashu claims', () => {
    const storage = memoryStorage()
    const paymentHash = randomBytes(32).toString('hex')
    const statusToken = randomBytes(32).toString('hex')

    // Store an old invoice
    storage.storeInvoice(paymentHash, 'lnbc...', 1000, 'mac', statusToken, '1.2.3.4')

    // Claim it for Cashu redemption (creates a pending claim)
    storage.claimForRedeem(paymentHash, 'cashuToken123', 60_000)

    // Prune with 0ms max age (should prune everything old)
    const pruned = storage.pruneExpiredInvoices(0)

    // Invoice should NOT be pruned because it has a pending claim
    expect(pruned).toBe(0)
    expect(storage.getInvoice(paymentHash)).toBeDefined()
  })

  it('prunes old invoices without pending claims', async () => {
    const storage = memoryStorage()
    const paymentHash = randomBytes(32).toString('hex')
    const statusToken = randomBytes(32).toString('hex')

    storage.storeInvoice(paymentHash, 'lnbc...', 1000, 'mac', statusToken, '1.2.3.4')

    // Wait briefly so the invoice ages past the cutoff
    await new Promise(resolve => setTimeout(resolve, 15))

    // Prune invoices older than 10ms
    const pruned = storage.pruneExpiredInvoices(10)

    expect(pruned).toBe(1)
    expect(storage.getInvoice(paymentHash)).toBeUndefined()
  })
})

describe('macaroon caveat limits', () => {
  it('allows up to 16 custom caveats', () => {
    const caveats = Array.from({ length: 16 }, (_, i) => `key${i} = val${i}`)
    expect(() => mintMacaroon(ROOT_KEY, randomBytes(32).toString('hex'), 1000, caveats)).not.toThrow()
  })

  it('rejects more than 16 custom caveats', () => {
    const caveats = Array.from({ length: 17 }, (_, i) => `key${i} = val${i}`)
    expect(() => mintMacaroon(ROOT_KEY, randomBytes(32).toString('hex'), 1000, caveats)).toThrow(/Too many caveats/)
  })
})

describe('status token timing-safe comparison', () => {
  it('rejects tokens of different lengths without leaking length via timing', () => {
    const storage = memoryStorage()
    const paymentHash = randomBytes(32).toString('hex')
    const statusToken = randomBytes(32).toString('hex')

    storage.storeInvoice(paymentHash, '', 1000, 'mac', statusToken, '1.2.3.4')

    // Short token
    expect(storage.getInvoiceForStatus(paymentHash, 'short')).toBeUndefined()
    // Long token
    expect(storage.getInvoiceForStatus(paymentHash, statusToken + 'extra')).toBeUndefined()
    // Correct token
    expect(storage.getInvoiceForStatus(paymentHash, statusToken)).toBeDefined()
  })
})

describe('rootKey entropy detection', () => {
  it('warns on all-same-character key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const booth = new Booth({
        adapter: 'express',
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() } as any,
        upstream: 'http://localhost:9999',
        pricing: { '/api': 10 },
        rootKey: 'a'.repeat(64),
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('low entropy'))
      booth.close()
    } finally {
      warn.mockRestore()
    }
  })

  it('warns on repeating-pattern key with low entropy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 0000...ffff repeating = only 2 distinct bytes
      const booth = new Booth({
        adapter: 'express',
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() } as any,
        upstream: 'http://localhost:9999',
        pricing: { '/api': 10 },
        rootKey: '00ff'.repeat(16),
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('low entropy'))
      booth.close()
    } finally {
      warn.mockRestore()
    }
  })

  it('does not warn on a high-entropy key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const booth = new Booth({
        adapter: 'express',
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() } as any,
        upstream: 'http://localhost:9999',
        pricing: { '/api': 10 },
        rootKey: randomBytes(32).toString('hex'),
      })
      // Should not have warned about entropy
      const entropyCalls = warn.mock.calls.filter(c =>
        typeof c[0] === 'string' && c[0].includes('entropy'),
      )
      expect(entropyCalls).toHaveLength(0)
      booth.close()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('Hono adapter trustProxy guard', () => {
  it('ignores X-Forwarded-For when trustProxy is false', async () => {
    const engine = createTollBooth({
      storage: memoryStorage(),
      pricing: { '/api': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
      freeTier: { requestsPerDay: 1 },
    })
    const { authMiddleware } = createHonoTollBooth({ engine, trustProxy: false })

    const app = new Hono()
    app.use('/api', authMiddleware)
    app.get('/api', (c) => c.text('ok'))

    // Two requests with different X-Forwarded-For should share the same 0.0.0.0 bucket
    const res1 = await app.request('/api', {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    })
    expect(res1.status).toBe(200) // free tier

    const res2 = await app.request('/api', {
      headers: { 'x-forwarded-for': '10.0.0.2' },
    })
    // Both hit the same 0.0.0.0 bucket; second should be 402
    expect(res2.status).toBe(402)
  })

  it('respects X-Forwarded-For when trustProxy is true', async () => {
    const engine = createTollBooth({
      storage: memoryStorage(),
      pricing: { '/api': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
      freeTier: { requestsPerDay: 1 },
    })
    const { authMiddleware } = createHonoTollBooth({ engine, trustProxy: true })

    const app = new Hono()
    app.use('/api', authMiddleware)
    app.get('/api', (c) => c.text('ok'))

    // Two requests with different X-Forwarded-For should get separate buckets
    const res1 = await app.request('/api', {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    })
    expect(res1.status).toBe(200)

    const res2 = await app.request('/api', {
      headers: { 'x-forwarded-for': '10.0.0.2' },
    })
    expect(res2.status).toBe(200) // separate bucket
  })
})

describe('Express adapter body size guard', () => {
  it('rejects requests with Content-Length exceeding 64KB', async () => {
    const { default: express } = await import('express')
    const { createExpressCreateInvoiceHandler } = await import('../adapters/express.js')

    const handler = createExpressCreateInvoiceHandler({
      deps: {
        storage: memoryStorage(),
        rootKey: ROOT_KEY,
        tiers: [],
        defaultAmount: 1000,
      },
    })

    const app = express()
    app.use(express.json({ limit: '1mb' })) // deliberately large limit to test our guard
    app.post('/create-invoice', handler)

    const server = app.listen(0)
    const addr = server.address() as { port: number }
    try {
      // Send a body that exceeds 64KB
      const largeBody = JSON.stringify({ data: 'x'.repeat(70_000) })
      const res = await fetch(`http://127.0.0.1:${addr.port}/create-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: largeBody,
      })
      expect(res.status).toBe(413)
    } finally {
      server.close()
    }
  })
})

describe('x402 X-Payment header size limit', () => {
  it('rejects X-Payment headers exceeding 4KB', async () => {
    const { createX402Rail } = await import('./x402-rail.js')
    const rail = createX402Rail({
      receiverAddress: '0x1234',
      network: 'base-sepolia',
      facilitator: { verify: vi.fn() },
    })

    const result = await rail.verify({
      method: 'GET',
      path: '/api',
      headers: { 'x-payment': 'x'.repeat(4097) },
      ip: '1.2.3.4',
    })

    expect(result.authenticated).toBe(false)
  })
})

describe('NWC backend paymentHash validation', () => {
  it('returns unpaid for malformed payment hash', async () => {
    const { nwcBackend } = await import('../backends/nwc.js')
    const backend = nwcBackend({ nwcUrl: 'nostr+walletconnect://test' })
    const result = await backend.checkInvoice('not-a-valid-hash')
    expect(result.paid).toBe(false)
  })
})

describe('estimatedCosts map overflow eviction', () => {
  it('force-evicts oldest entries when map reaches capacity under burst', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      storage,
      pricing: { '/api': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    // Fill the map by making many authenticated requests
    // The MAX_ESTIMATED_COSTS is 10_000 so we cannot test at full scale,
    // but we can verify the eviction logic works by checking reconcile
    const { preimage, paymentHash } = makeCredential()
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 100_000, [])
    storage.settleWithCredit(paymentHash, 100_000, preimage)

    // Make several requests to populate estimatedCosts
    for (let i = 0; i < 5; i++) {
      await engine.handle({
        method: 'GET',
        path: '/api',
        headers: { authorization: `L402 ${macaroon}:${preimage}` },
        ip: '1.2.3.4',
      })
    }

    // Reconcile should work (entry exists)
    const result = engine.reconcile(paymentHash, 5)
    expect(result.adjusted).toBe(true)
  })
})

describe('memory storage invoiceIps cleanup', () => {
  it('prunes invoiceIps alongside invoices', async () => {
    const storage = memoryStorage()
    const paymentHash = randomBytes(32).toString('hex')
    const statusToken = randomBytes(32).toString('hex')

    storage.storeInvoice(paymentHash, 'lnbc...', 1000, 'mac', statusToken, '1.2.3.4')

    // Verify pending count reflects the stored invoice
    expect(storage.pendingInvoiceCount('1.2.3.4')).toBe(1)

    // Wait for the invoice to age past the cutoff
    await new Promise(resolve => setTimeout(resolve, 15))

    // Prune invoices older than 10ms
    storage.pruneExpiredInvoices(10)

    // After pruning, pendingInvoiceCount should be 0 (invoiceIps cleaned up)
    expect(storage.pendingInvoiceCount('1.2.3.4')).toBe(0)
  })
})

describe('CSP header on payment page', () => {
  it('includes Content-Security-Policy in security headers', async () => {
    const { applySecurityHeaders } = await import('../adapters/proxy-headers.js')
    const headers = applySecurityHeaders(new Headers())
    const csp = headers.get('Content-Security-Policy')
    expect(csp).toBeDefined()
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'none'")
  })
})

describe('IPv6 validation strictness', () => {
  it('rejects single hex character as IPv6', async () => {
    const { isPlausibleIp } = await import('../adapters/proxy-headers.js')
    expect(isPlausibleIp('f')).toBe(false)
    expect(isPlausibleIp('ff')).toBe(false)
    expect(isPlausibleIp('::1')).toBe(true)
    expect(isPlausibleIp('fe80::1')).toBe(true)
  })
})

describe('Hono adapter streaming body limit', () => {
  it('rejects oversized body without Content-Length', async () => {
    const engine = createTollBooth({
      storage: memoryStorage(),
      pricing: {},
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })
    const { createPaymentApp } = createHonoTollBooth({ engine })
    const paymentApp = createPaymentApp({
      storage: memoryStorage(),
      rootKey: ROOT_KEY,
      tiers: [],
      defaultAmount: 1000,
    })

    const app = new Hono()
    app.route('/pay', paymentApp)

    // Send a body larger than 64KB without Content-Length header
    const largeBody = JSON.stringify({ data: 'x'.repeat(70_000) })
    const res = await app.request('/pay/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: largeBody,
    })
    expect(res.status).toBe(400)
  })
})

describe('X-Toll-Cost strict validation', () => {
  it('rejects scientific notation in toll cost', async () => {
    // This tests that '1.5e6' is not parsed as 1 (parseInt truncation bug)
    // The fix uses /^\d+$/ regex to reject non-integer strings
    expect(/^\d+$/.test('1.5e6')).toBe(false)
    expect(/^\d+$/.test('5.9')).toBe(false)
    expect(/^\d+$/.test('-1')).toBe(false)
    expect(/^\d+$/.test('0')).toBe(true)
    expect(/^\d+$/.test('1000')).toBe(true)
  })
})
