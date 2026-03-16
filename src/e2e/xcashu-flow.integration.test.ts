// src/e2e/xcashu-flow.integration.test.ts
//
// Integration test for the xcashu (NUT-24) payment rail.
// The basic header-presence tests run without any mint.
// The full payment flow requires a Nutshell mint — run via:
//   RUN_INTEGRATION=true CASHU_MINT_URL=http://localhost:13338 npm test -- src/e2e/xcashu-flow.integration.test.ts
//
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Mint, Wallet, MintQuoteState, getEncodedTokenV4, type Proof } from '@cashu/cashu-ts'
import { Booth } from '../booth.js'
import { memoryStorage } from '../storage/memory.js'
import type { LightningBackend } from '../types.js'
import type { WebStandardHandler } from '../adapters/web-standard.js'
import { createHash, randomBytes } from 'node:crypto'

const MINT_URL = process.env.CASHU_MINT_URL ?? 'http://localhost:13338'
const RUN_INTEGRATION = process.env.RUN_INTEGRATION === 'true'

// ---------------------------------------------------------------------------
// Fake Lightning backend — xcashu tests don't require real Lightning
// ---------------------------------------------------------------------------
const fakeBackend: LightningBackend = {
  async createInvoice(amountSats) {
    const preimage = randomBytes(32).toString('hex')
    const paymentHash = createHash('sha256')
      .update(Buffer.from(preimage, 'hex'))
      .digest('hex')
    return { bolt11: `lnbc${amountSats}n1fake`, paymentHash }
  },
  async checkInvoice() {
    return { paid: false }
  },
}

// ---------------------------------------------------------------------------
// Helper: build a minimal Web Standard request helper from a Booth
// ---------------------------------------------------------------------------
function makeRequestHelper(booth: Booth) {
  const middleware = booth.middleware as WebStandardHandler
  const invoiceStatusHandler = booth.invoiceStatusHandler as WebStandardHandler
  const createInvoiceHandler = booth.createInvoiceHandler as WebStandardHandler

  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, 'http://localhost')
    const req = new Request(url, init)
    const path = url.pathname
    if (path.startsWith('/invoice-status/')) return invoiceStatusHandler(req)
    if (path === '/create-invoice') return createInvoiceHandler(req)
    return middleware(req)
  }
}

// ---------------------------------------------------------------------------
// Helper: mint fresh proofs from a Nutshell FakeWallet
// ---------------------------------------------------------------------------
async function mintProofs(wallet: Wallet, amount: number): Promise<Proof[]> {
  const quote = await wallet.createMintQuoteBolt11(amount)

  // FakeWallet auto-marks as paid, but poll to be safe
  for (let i = 0; i < 15; i++) {
    const state = await wallet.checkMintQuoteBolt11(quote.quote)
    if (state.state === MintQuoteState.PAID) break
    await new Promise((r) => setTimeout(r, 250))
  }

  return wallet.mintProofs(amount, quote.quote)
}

// ---------------------------------------------------------------------------
// Tests that do NOT require a live mint
// ---------------------------------------------------------------------------
describe('xcashu rail — header checks (no mint required)', () => {
  let booth: Booth
  let request: ReturnType<typeof makeRequestHelper>

  beforeAll(() => {
    booth = new Booth({
      adapter: 'web-standard',
      backend: fakeBackend,
      xcashu: {
        mints: ['https://mint.minibits.cash'],
        unit: 'sat',
      },
      pricing: { '/api/data': 10 },
      upstream: 'http://localhost:1', // not used in these tests
      rootKey: 'e'.repeat(64),
      storage: memoryStorage(),
      defaultInvoiceAmount: 100,
      getClientIp: () => '127.0.0.1',
    })

    request = makeRequestHelper(booth)
  })

  afterAll(() => {
    booth?.close()
  })

  it('returns 402 on a priced endpoint', async () => {
    const res = await request('/api/data')
    expect(res.status).toBe(402)
  })

  it('402 response includes X-Cashu header (payment request)', async () => {
    const res = await request('/api/data')
    expect(res.status).toBe(402)
    const xcashu = res.headers.get('X-Cashu')
    expect(xcashu).toBeTruthy()
    // The challenge sends a NUT-18 payment request, not a token
    expect(xcashu).toMatch(/^creqA/)
  })

  it('402 response includes WWW-Authenticate header (L402) alongside X-Cashu', async () => {
    const res = await request('/api/data')
    expect(res.status).toBe(402)

    // Both rails contribute to the same challenge response
    const wwwAuth = res.headers.get('WWW-Authenticate')
    const xcashu = res.headers.get('X-Cashu')

    expect(wwwAuth).toBeTruthy()
    expect(wwwAuth).toMatch(/^L402/)
    expect(xcashu).toBeTruthy()
    expect(xcashu).toMatch(/^creqA/)
  })

  it('402 body includes xcashu object with amount, unit, and mints', async () => {
    const res = await request('/api/data')
    const body = await res.json() as Record<string, unknown>

    const xcashu = body.xcashu as Record<string, unknown>
    expect(xcashu).toBeDefined()
    expect(xcashu.amount).toBe(10)
    expect(xcashu.unit).toBe('sat')
    expect(Array.isArray(xcashu.mints)).toBe(true)
    expect((xcashu.mints as string[])[0]).toBe('https://mint.minibits.cash')
  })

  it('xcashu-only booth (no Lightning backend) also returns X-Cashu on 402', async () => {
    const xcashuOnlyBooth = new Booth({
      adapter: 'web-standard',
      xcashu: {
        mints: ['https://mint.minibits.cash'],
        unit: 'sat',
      },
      pricing: { '/api/data': 10 },
      upstream: 'http://localhost:1',
      rootKey: 'f'.repeat(64),
      storage: memoryStorage(),
      getClientIp: () => '127.0.0.1',
    })

    try {
      const xcashuOnlyRequest = makeRequestHelper(xcashuOnlyBooth)
      const res = await xcashuOnlyRequest('/api/data')
      expect(res.status).toBe(402)

      const xcashu = res.headers.get('X-Cashu')
      expect(xcashu).toBeTruthy()
      expect(xcashu).toMatch(/^creqA/)

      // No L402 header — no Lightning backend configured
      const wwwAuth = res.headers.get('WWW-Authenticate')
      expect(wwwAuth).toBeNull()
    } finally {
      xcashuOnlyBooth.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Full payment flow — requires a live Nutshell mint
// ---------------------------------------------------------------------------
describe.skipIf(!RUN_INTEGRATION)('xcashu full payment flow (requires Nutshell mint)', () => {
  let wallet: Wallet
  let booth: Booth
  let request: ReturnType<typeof makeRequestHelper>

  beforeAll(async () => {
    // Initialise a cashu-ts Wallet pointing at the test mint
    const mint = new Mint(MINT_URL)
    wallet = new Wallet(mint, { unit: 'sat' })
    await wallet.loadMint()

    booth = new Booth({
      adapter: 'web-standard',
      backend: fakeBackend,
      xcashu: {
        mints: [MINT_URL],
        unit: 'sat',
      },
      pricing: { '/api/data': 5 },
      upstream: 'http://localhost:1', // not used — tests don't proxy
      rootKey: 'a'.repeat(64),
      storage: memoryStorage(),
      defaultInvoiceAmount: 100,
      getClientIp: () => '127.0.0.1',
    })

    request = makeRequestHelper(booth)
  }, 30_000)

  afterAll(() => {
    booth?.close()
  })

  it('valid xcashu token authorises access', async () => {
    // 1. Trigger a 402 — confirm both challenge headers are present
    const challengeRes = await request('/api/data')
    expect(challengeRes.status).toBe(402)
    expect(challengeRes.headers.get('X-Cashu')).toBeTruthy()

    // 2. Mint proofs for the route cost
    const proofs = await mintProofs(wallet, 5)
    const token = getEncodedTokenV4({ proofs, mint: MINT_URL })

    // 3. Send token via X-Cashu request header
    const authedRes = await request('/api/data', {
      headers: { 'X-Cashu': token },
    })

    // Should not get a 402; upstream not running so may be 502/503/error but NOT 402
    expect(authedRes.status).not.toBe(402)
  }, 30_000)

  it('X-Credit-Balance is present on successful xcashu payment', async () => {
    const proofs = await mintProofs(wallet, 10)
    const token = getEncodedTokenV4({ proofs, mint: MINT_URL })

    const res = await request('/api/data', {
      headers: { 'X-Cashu': token },
    })

    // Regardless of upstream status, the credit balance header must be set
    expect(res.headers.get('X-Credit-Balance')).toBeTruthy()
    // Paid 10 sats, route costs 5 → balance should be 5
    const balance = Number(res.headers.get('X-Credit-Balance'))
    expect(balance).toBe(5)
  }, 30_000)

  it('rejects a spent token (double-spend prevention)', async () => {
    const proofs = await mintProofs(wallet, 5)
    const token = getEncodedTokenV4({ proofs, mint: MINT_URL })

    // First use — should succeed
    const first = await request('/api/data', {
      headers: { 'X-Cashu': token },
    })
    expect(first.status).not.toBe(402)

    // Second use — proofs are already spent at the mint
    const second = await request('/api/data', {
      headers: { 'X-Cashu': token },
    })
    expect(second.status).toBe(402)
  }, 60_000)
})
