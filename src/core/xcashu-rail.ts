import { randomBytes } from 'node:crypto'
import { Wallet, getDecodedToken } from '@cashu/cashu-ts'
import type { TollBoothRequest } from './types.js'
import type { PaymentRail, PriceInfo, ChallengeFragment, RailVerifyResult, Currency } from './payment-rail.js'
import type { XCashuConfig } from '../types.js'
import type { StorageBackend } from '../storage/interface.js'

const FAIL: RailVerifyResult = { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }

/**
 * Encode a NUT-18-style payment request for the X-Cashu header.
 * Simplified JSON encoding — full CBOR encoding can be added later
 * if cashu-ts exposes a PaymentRequest builder.
 */
function encodePaymentRequest(amount: number, unit: Currency, mints: string[]): string {
  const payload = JSON.stringify({ a: amount, u: unit, m: mints })
  return 'creqA' + Buffer.from(payload).toString('base64url')
}

export function createXCashuRail(config: XCashuConfig, storage?: StorageBackend): PaymentRail {
  const unit: Currency = config.unit ?? 'sat'
  const mintUrls = config.mints

  // Lazily initialised wallets per mint (loadMint is async, done on first use)
  const wallets = new Map<string, Wallet>()
  const walletReady = new Map<string, Promise<Wallet>>()

  async function getWallet(mintUrl: string): Promise<Wallet> {
    const existing = walletReady.get(mintUrl)
    if (existing) return existing

    const promise = (async () => {
      const wallet = new Wallet(mintUrl, { unit })
      await wallet.loadMint()
      wallets.set(mintUrl, wallet)
      return wallet
    })()
    walletReady.set(mintUrl, promise)
    return promise
  }

  return {
    type: 'xcashu',
    creditSupported: true,

    canChallenge(price: PriceInfo): boolean {
      return price.sats !== undefined
    },

    detect(req: TollBoothRequest): boolean {
      const header = req.headers['x-cashu']
      return typeof header === 'string' && header.startsWith('cashuB')
    },

    async challenge(_route: string, price: PriceInfo): Promise<ChallengeFragment> {
      const amount = price.sats!
      const encoded = encodePaymentRequest(amount, unit, mintUrls)
      return {
        headers: { 'X-Cashu': encoded },
        body: {
          xcashu: { amount, unit, mints: mintUrls },
        },
      }
    },

    async verify(req: TollBoothRequest): Promise<RailVerifyResult> {
      const header = req.headers['x-cashu']
      if (typeof header !== 'string' || !header.startsWith('cashuB')) {
        return FAIL
      }

      let decoded
      try {
        decoded = getDecodedToken(header)
      } catch {
        return FAIL
      }

      // Validate mint is accepted
      const tokenMint = decoded.mint
      if (!tokenMint || !mintUrls.includes(tokenMint)) {
        return FAIL
      }

      // Validate unit matches
      if (decoded.unit && decoded.unit !== unit) {
        return FAIL
      }

      // Get or initialise wallet for this mint
      let wallet: Wallet
      try {
        wallet = await getWallet(tokenMint)
      } catch {
        return FAIL
      }

      // Swap proofs at the mint to verify and claim them
      let receivedProofs
      try {
        receivedProofs = await wallet.receive(header)
      } catch {
        // Mint unreachable, proofs already spent, or other error
        return FAIL
      }

      const creditedAmount = receivedProofs.reduce((sum, p) => sum + p.amount, 0)
      if (creditedAmount <= 0) {
        return FAIL
      }

      // Generate payment ID and settlement secret
      const paymentId = randomBytes(32).toString('hex')
      const settlementSecret = randomBytes(32).toString('hex')

      // Settle credit if storage available
      if (storage && !storage.isSettled(paymentId)) {
        storage.settleWithCredit(paymentId, creditedAmount, settlementSecret, unit)
      }

      return {
        authenticated: true,
        paymentId,
        mode: 'credit',
        currency: unit,
        creditBalance: creditedAmount,
      }
    },
  }
}
