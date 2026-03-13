// src/e2e/cashu-redeem.integration.test.ts
//
// Integration test for Cashu token redemption against a real Nutshell mint.
// Skipped by default — run via: npm run test:integration --cashu-only
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

  return wallet.mintProofs(amount, quote.quote)
}

describe.skipIf(!RUN_INTEGRATION)('Cashu redemption integration (requires Nutshell)', () => {
  let wallet: Wallet
  let booth: Booth
  let request: (input: string | URL, init?: RequestInit) => Promise<Response>

  // Fake Lightning backend — Cashu tests don't need real Lightning
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

  beforeAll(async () => {
    // Initialise Cashu wallet
    const mint = new Mint(MINT_URL)
    wallet = new Wallet(mint, { unit: 'sat' })
    await wallet.loadMint()

    // Create Booth with real Cashu redemption
    const redeemCashu = async (token: string, _paymentHash: string): Promise<number> => {
      const proofs = await wallet.receive(token)
      return proofs.reduce((sum, p) => sum + p.amount, 0)
    }

    booth = new Booth({
      adapter: 'web-standard',
      backend: fakeBackend,
      pricing: { '/api/data': 5 },
      upstream: 'http://localhost:1', // Not used — Cashu tests don't proxy
      rootKey: 'c'.repeat(64),
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

  it('redeems Cashu token and credits the payment hash', async () => {
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
    const totalMinted = proofs.reduce((sum, p) => sum + p.amount, 0)
    expect(totalMinted).toBe(challenge.amount_sats)

    // 3. Encode as Cashu token
    const token = getEncodedTokenV4({ proofs, mint: MINT_URL })

    // 4. Redeem through the Booth's handler
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
  }, 30_000)

  it('idempotent: second redemption returns credited=0', async () => {
    // Trigger a 402
    const challengeRes = await request('/api/data')
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

    // Mint and redeem
    const proofs = await mintProofs(wallet, challenge.amount_sats)
    const token = getEncodedTokenV4({ proofs, mint: MINT_URL })

    await request('/cashu-redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, paymentHash: challenge.payment_hash, statusToken }),
    })

    // Second redemption — already settled
    const res2 = await request('/cashu-redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'cashuA_stale', paymentHash: challenge.payment_hash, statusToken }),
    })

    expect(res2.status).toBe(200)
    const body2 = await res2.json() as { credited: number }
    expect(body2.credited).toBe(0)
  }, 30_000)

  it('Cashu-paid macaroon authorises access via L402 header', async () => {
    // Trigger a 402
    const challengeRes = await request('/api/data')
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

    // Mint + redeem
    const proofs = await mintProofs(wallet, challenge.amount_sats)
    const token = getEncodedTokenV4({ proofs, mint: MINT_URL })

    const redeemRes = await request('/cashu-redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, paymentHash: challenge.payment_hash, statusToken }),
    })
    const redeemBody = await redeemRes.json() as { token_suffix: string }

    // Use macaroon with settlement token suffix from redemption response
    const authedRes = await request('/api/data', {
      headers: { Authorization: `L402 ${challenge.macaroon}:${redeemBody.token_suffix}` },
    })

    // Won't be 200 (upstream not running) but MUST NOT be 402
    expect(authedRes.status).not.toBe(402)
  }, 30_000)
})
