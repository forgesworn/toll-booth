import { randomBytes } from 'node:crypto'
import type { TollBoothRequest } from './types.js'
import type { PaymentRail, PriceInfo, ChallengeFragment, RailVerifyResult } from './payment-rail.js'
import type { X402RailConfig, X402Payment, X402PaymentWire, X402ChallengeWire, X402PaymentRequirements } from './x402-types.js'
import { DEFAULT_USDC_ASSETS, X402_VERSION } from './x402-types.js'

/**
 * Normalise an inbound x402 v2 PAYMENT-SIGNATURE payload to the flat
 * internal X402Payment format used by the facilitator interface.
 */
function normaliseV2Payload(wire: X402PaymentWire): X402Payment | undefined {
  const auth = wire.payload?.authorization
  if (!auth) return undefined
  const amount = Number(auth.value)
  if (!Number.isFinite(amount)) return undefined
  return {
    signature: wire.payload.signature,
    sender: auth.from,
    amount,
    network: wire.accepted?.network ?? '',
    nonce: auth.nonce,
    asset: wire.accepted?.asset,
    payTo: wire.accepted?.payTo,
  }
}

/**
 * Try to parse the payment from either the v2 PAYMENT-SIGNATURE header
 * (base64-encoded JSON) or the legacy X-Payment header (raw JSON).
 */
function parsePayment(req: TollBoothRequest): X402Payment | undefined {
  // v2: PAYMENT-SIGNATURE (base64-encoded JSON)
  const sigHeader = req.headers['payment-signature']
  if (sigHeader && sigHeader.length <= 8192) {
    try {
      const decoded = JSON.parse(Buffer.from(sigHeader, 'base64').toString()) as X402PaymentWire
      if (decoded.x402Version >= 2) return normaliseV2Payload(decoded)
    } catch { /* fall through to legacy */ }
  }

  // Legacy: X-Payment (raw JSON)
  const raw = req.headers['x-payment']
  if (!raw || raw.length > 4096) return undefined
  try {
    return JSON.parse(raw) as X402Payment
  } catch {
    return undefined
  }
}

export function createX402Rail(config: X402RailConfig): PaymentRail {
  const {
    receiverAddress,
    network,
    asset = DEFAULT_USDC_ASSETS[network],
    facilitator,
    creditMode = true,
    facilitatorUrl,
    maxTimeoutSeconds = 3600,
    storage,
  } = config

  /** Build the advertised payment requirements for a USD price (cents). */
  function buildRequirements(priceUsd: number): X402PaymentRequirements {
    return {
      scheme: 'exact',
      network,
      amount: String(priceUsd),
      asset: asset ?? '',
      payTo: receiverAddress,
      maxTimeoutSeconds,
      extra: {
        ...(facilitatorUrl && { facilitatorUrl }),
      },
    }
  }

  return {
    type: 'x402',
    creditSupported: true,

    canChallenge(price: PriceInfo): boolean {
      return price.usd !== undefined
    },

    detect(req: TollBoothRequest): boolean {
      return req.headers['payment-signature'] !== undefined
        || req.headers['x-payment'] !== undefined
    },

    async challenge(route: string, price: PriceInfo): Promise<ChallengeFragment> {
      const requirements: X402ChallengeWire = {
        x402Version: X402_VERSION,
        accepts: [buildRequirements(price.usd!)],
        resource: { url: route },
      }

      const encoded = Buffer.from(JSON.stringify(requirements)).toString('base64')

      return {
        headers: {
          'Payment-Required': encoded,
        },
        body: {
          x402: {
            version: X402_VERSION,
            receiver: receiverAddress,
            network,
            asset,
            amount_usd: price.usd,
            ...(facilitatorUrl && { facilitator: facilitatorUrl }),
          },
        },
      }
    },

    async verify(req: TollBoothRequest, price?: PriceInfo): Promise<RailVerifyResult> {
      const unauthenticated: RailVerifyResult = { authenticated: false, paymentId: '', mode: 'per-request', currency: 'usd' }

      const payload = parsePayment(req)
      if (!payload) {
        return unauthenticated
      }

      // The route must have a USD price — otherwise there is nothing to
      // validate the payment against. Fail closed.
      const requiredUsd = price?.usd
      if (requiredUsd === undefined) {
        return unauthenticated
      }

      // Validate required fields before passing to facilitator
      if (
        typeof payload.signature !== 'string' || !payload.signature ||
        typeof payload.sender !== 'string' || !payload.sender ||
        typeof payload.amount !== 'number' || !Number.isFinite(payload.amount) || payload.amount <= 0 ||
        typeof payload.network !== 'string' || !payload.network ||
        typeof payload.nonce !== 'string' || !payload.nonce
      ) {
        return unauthenticated
      }

      // Validate the payload against the advertised requirements BEFORE
      // calling the facilitator. The network field is attacker-controlled,
      // and the claimed amount must cover the route price — a validly
      // signed 1-cent transfer must not satisfy a $10 route.
      const requirements = buildRequirements(requiredUsd)
      if (
        payload.network !== requirements.network ||
        payload.amount < requiredUsd ||
        (payload.payTo !== undefined && payload.payTo !== requirements.payTo) ||
        (payload.asset !== undefined && payload.asset !== requirements.asset)
      ) {
        return unauthenticated
      }

      try {
        const result = await facilitator.verify(payload, requirements)
        if (!result.valid) {
          return { authenticated: false, paymentId: result.txHash || '', mode: 'per-request', currency: 'usd' }
        }

        // Post-verification: the settled amount must cover the route price.
        if (!Number.isFinite(result.amount) || result.amount < requiredUsd) {
          return { authenticated: false, paymentId: result.txHash || '', mode: 'per-request', currency: 'usd' }
        }

        // Credit mode: persist balance to storage (mirrors L402 rail's settleWithCredit).
        // Generate a random settlement secret; the txHash is public on-chain
        // and must never be used as a bearer credential.
        if (creditMode && storage && !storage.isSettled(result.txHash)) {
          const settlementSecret = randomBytes(32).toString('hex')
          storage.settleWithCredit(result.txHash, result.amount, settlementSecret, 'usd')
        }

        const creditBalance = creditMode && storage
          ? storage.balance(result.txHash, 'usd')
          : (creditMode ? result.amount : undefined)

        return {
          authenticated: true,
          paymentId: result.txHash,
          mode: creditMode ? 'credit' : 'per-request',
          creditBalance,
          currency: 'usd',
        }
      } catch {
        return { authenticated: false, paymentId: '', mode: 'per-request', currency: 'usd' }
      }
    },

  }
}
