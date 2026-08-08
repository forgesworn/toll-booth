// src/e2e/cashu-only.integration.test.ts
//
// End-to-end test of Cashu-only mode (no Lightning backend).
// Skipped by default — run via: npm run test:integration --cashu-only
//
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Mint, Wallet, MintQuoteState, getEncodedToken, sumProofs, type Proof } from '@cashu/cashu-ts'
import { Booth } from '../booth.js'
import { memoryStorage } from '../storage/memory.js'
import type { WebStandardHandler } from '../adapters/web-standard.js'

const MINT_URL = process.env.CASHU_MINT_URL ?? 'http://localhost:13338'
const RUN_INTEGRATION = process.env.RUN_INTEGRATION === 'true'

function extractStatusToken(paymentUrl: string): string {
  const url = new URL(paymentUrl, 'http://localhost')
  const token = url.searchParams.get('token')
  if (!token) throw new Error('payment_url is missing token')
  return token
}

/** Mint fresh Cashu proofs from the Nutshell FakeWallet. */
async function mintProofs(wallet: Wallet, amount: number): Promise<Proof[]> {
  const quote = await wallet.createMintQuoteBolt11(amount)

  // FakeWallet auto-marks as paid, but poll to be safe
  for (let i = 0; i < 15; i++) {
    const state = await wallet.checkMintQuoteBolt11(quote.quote)
    if (state.state === MintQuoteState.PAID) break
    await new Promise((r) => setTimeout(r, 250))
  }

  return wallet.mintProofsBolt11(amount, quote.quote)
}

describe.skipIf(!RUN_INTEGRATION)('Cashu-only mode integration (requires Nutshell)', () => {
  let wallet: Wallet
  let booth: Booth
  let request: (input: string | URL, init?: RequestInit) => Promise<Response>

  beforeAll(async () => {
    // Initialise Cashu wallet
    const mint = new Mint(MINT_URL)
    wallet = new Wallet(mint, { unit: 'sat' })
    await wallet.loadMint()

    // Create Booth with NO Lightning backend — Cashu only
    const redeemCashu = async (token: string, _paymentHash: string): Promise<number> => {
      const proofs = await wallet.receive(token)
      return sumProofs(proofs).toNumber()
    }

    booth = new Booth({
      adapter: 'web-standard',
      // No backend — Cashu-only mode
      pricing: { '/api/data': 5 },
      upstream: 'http://localhost:1', // Not used — we test auth, not proxying
      rootKey: 'd'.repeat(64),
      storage: memoryStorage(),
      defaultInvoiceAmount: 100,
      redeemCashu,
      getClientIp: () => '127.0.0.1',
    })

    const middleware = booth.middleware as WebStandardHandler
    const invoiceStatusHandler = booth.invoiceStatusHandler as WebStandardHandler
    const createInvoiceHandler = booth.createInvoiceHandler as WebStandardHandler
    const cashuRedeemHandler = booth.cashuRedeemHandler as WebStandardHandler

    request = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input, 'http://localhost')
      const req = new Request(url, init)
      const path = url.pathname
      if (path.startsWith('/invoice-status/')) return invoiceStatusHandler(req)
      if (path === '/create-invoice') return createInvoiceHandler(req)
      if (path === '/cashu-redeem') return cashuRedeemHandler(req)
      return middleware(req)
    }
  }, 30_000)

  afterAll(() => {
    booth?.close()
  })

  it('402 challenge has no bolt11 invoice', async () => {
    const res = await request('/api/data')
    expect(res.status).toBe(402)

    const body = await res.json() as Record<string, unknown>
    const l402 = body.l402 as Record<string, unknown>
    expect(l402.payment_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(l402.macaroon).toBeTruthy()
    expect(l402.invoice).toBe('')
  })

  it('full Cashu-only flow: 402 → mint tokens → redeem → authorise', async () => {
    // 1. Trigger a 402 to get a payment hash + macaroon
    const challengeRes = await request('/api/data')
    expect(challengeRes.status).toBe(402)
    const challengeBody = await challengeRes.json() as {
      l402: {
        payment_hash: string
        macaroon: string
        amount_sats: number
        payment_url: string
      }
    }
    const challenge = challengeBody.l402
    const statusToken = extractStatusToken(challenge.payment_url)

    // 2. Mint Cashu proofs for the invoice amount
    const proofs = await mintProofs(wallet, challenge.amount_sats)
    const totalMinted = sumProofs(proofs).toNumber()
    expect(totalMinted).toBe(challenge.amount_sats)

    // 3. Encode as Cashu token and redeem
    const token = getEncodedToken({ proofs, mint: MINT_URL })
    const redeemRes = await request('/cashu-redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, paymentHash: challenge.payment_hash, statusToken }),
    })

    expect(redeemRes.status).toBe(200)
    const redeemBody = await redeemRes.json() as { credited: number; token_suffix: string; macaroon?: string }
    expect(redeemBody.credited).toBe(challenge.amount_sats)
    expect(redeemBody.macaroon).toBeUndefined()
    expect(redeemBody.token_suffix).toBeTruthy()

    // 4. Use macaroon to access gated endpoint
    const authedRes = await request('/api/data', {
      headers: { Authorization: `L402 ${challenge.macaroon}:${redeemBody.token_suffix}` },
    })

    // Won't be 200 (upstream not running) but MUST NOT be 402
    expect(authedRes.status).not.toBe(402)
  }, 30_000)

  it('invoice-status reflects settlement without Lightning backend', async () => {
    // 1. Get a challenge
    const challengeRes = await request('/api/data')
    const challengeBody2 = await challengeRes.json() as {
      l402: {
        payment_hash: string
        amount_sats: number
        payment_url: string
      }
    }
    const challenge = challengeBody2.l402
    const statusToken = extractStatusToken(challenge.payment_url)

    // 2. Check status before payment — should be unpaid
    const statusBefore = await request(challenge.payment_url)
    expect(statusBefore.status).toBe(200)
    const bodyBefore = await statusBefore.json() as { paid: boolean }
    expect(bodyBefore.paid).toBe(false)

    // 3. Pay via Cashu
    const proofs = await mintProofs(wallet, challenge.amount_sats)
    const token = getEncodedToken({ proofs, mint: MINT_URL })
    await request('/cashu-redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, paymentHash: challenge.payment_hash, statusToken }),
    })

    // 4. Check status after payment — should be paid
    const statusAfter = await request(challenge.payment_url)
    expect(statusAfter.status).toBe(200)
    const bodyAfter = await statusAfter.json() as { paid: boolean }
    expect(bodyAfter.paid).toBe(true)
  }, 30_000)
})
