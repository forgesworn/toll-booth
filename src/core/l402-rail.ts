import { createHash, timingSafeEqual, randomBytes } from 'node:crypto'
import { mintMacaroon, verifyMacaroon } from '../macaroon.js'
import type { StorageBackend } from '../storage/interface.js'
import type { LightningBackend } from '../types.js'
import type { TollBoothRequest } from './types.js'
import type { PaymentRail, PriceInfo, ChallengeFragment, RailVerifyResult } from './payment-rail.js'

export interface L402RailConfig {
  rootKey: string
  storage: StorageBackend
  defaultAmount: number
  backend?: LightningBackend
  /** Human-readable service name for invoice descriptions. Defaults to 'toll-booth'. */
  serviceName?: string
}

export function createL402Rail(config: L402RailConfig): PaymentRail {
  const { rootKey, storage, defaultAmount, backend } = config
  const label = config.serviceName ?? 'toll-booth'

  return {
    type: 'l402',
    creditSupported: true,

    canChallenge(price: PriceInfo): boolean {
      return price.sats !== undefined
    },

    detect(req: TollBoothRequest): boolean {
      const auth = req.headers.authorization ?? req.headers.Authorization ?? ''
      return /^L402\s/i.test(auth)
    },

    async challenge(route: string, _price: PriceInfo): Promise<ChallengeFragment> {
      const amount = defaultAmount
      let bolt11 = ''
      let paymentHash: string

      if (backend) {
        const invoice = await backend.createInvoice(amount, `${label}: ${route}`)
        bolt11 = invoice.bolt11
        paymentHash = invoice.paymentHash
      } else {
        paymentHash = randomBytes(32).toString('hex')
      }

      const macaroon = mintMacaroon(rootKey, paymentHash, amount)

      return {
        headers: {
          'WWW-Authenticate': `L402 macaroon="${macaroon}", invoice="${bolt11}"`,
        },
        body: {
          l402: {
            scheme: 'L402',
            description: 'Buy credits \u2014 pay once, reuse for multiple requests',
            invoice: bolt11,
            macaroon,
            payment_hash: paymentHash,
            amount_sats: amount,
          },
        },
      }
    },

    // NOTE: verify() only authenticates — it does NOT debit.
    // Balance tracking and debit stay in the engine (per spec).
    verify(req: TollBoothRequest): RailVerifyResult {
      const auth = req.headers.authorization ?? req.headers.Authorization ?? ''
      const token = auth.replace(/^L402\s+/i, '')
      const lastColon = token.lastIndexOf(':')

      if (lastColon === -1) {
        return { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }
      }

      const macaroonBase64 = token.slice(0, lastColon)
      const preimage = token.slice(lastColon + 1)

      const context = req.path ? { path: req.path, ip: req.ip } : undefined
      const verification = verifyMacaroon(rootKey, macaroonBase64, context)

      if (!verification.valid) {
        return { authenticated: false, paymentId: '', mode: 'credit', currency: 'sat' }
      }

      const paymentHash = verification.paymentHash!
      const creditBalance = verification.creditBalance ?? defaultAmount

      // Verify preimage: Lightning (sha256) or Cashu (settlement secret)
      const isLightning = isValidLightningPreimage(preimage, paymentHash)
      const settlementSecret = storage.getSettlementSecret(paymentHash)
      const isCashu = settlementSecret !== undefined &&
        preimage.length === settlementSecret.length &&
        timingSafeEqual(Buffer.from(preimage), Buffer.from(settlementSecret))

      if (!isLightning && !isCashu) {
        return { authenticated: false, paymentId: paymentHash, mode: 'credit', currency: 'sat' }
      }

      // First-time settlement — credits the balance.
      // Only reachable with a valid proof (Lightning preimage or Cashu secret).
      // If settleWithCredit loses a race, another request already settled — continue.
      // Use a random settlement secret rather than the raw preimage to avoid
      // leaking the bearer credential via getSettlementSecret / invoice-status.
      if (!storage.isSettled(paymentHash)) {
        const secret = randomBytes(32).toString('hex')
        storage.settleWithCredit(paymentHash, creditBalance, secret)
      }

      // Return current balance — engine will debit and check sufficiency
      const remaining = storage.balance(paymentHash)

      return {
        authenticated: true,
        paymentId: paymentHash,
        mode: 'credit',
        creditBalance: remaining,
        currency: 'sat',
        customCaveats: verification.customCaveats,
      }
    },
  }
}

function isValidLightningPreimage(preimage: string, paymentHash: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(preimage)) return false
  const computed = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest()
  return timingSafeEqual(computed, Buffer.from(paymentHash, 'hex'))
}
