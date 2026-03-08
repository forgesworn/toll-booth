// src/core/toll-booth.ts
import { createHash } from 'node:crypto'
import { mintMacaroon, verifyMacaroon } from '../macaroon.js'
import { FreeTier } from '../free-tier.js'
import type { StorageBackend } from '../storage/interface.js'
import type { TollBoothRequest, TollBoothResult, TollBoothCoreConfig } from './types.js'

export interface TollBoothEngine {
  handle(req: TollBoothRequest): Promise<TollBoothResult>
  freeTier: FreeTier | null
  upstream: string
}

export function createTollBooth(config: TollBoothCoreConfig): TollBoothEngine {
  const defaultAmount = config.defaultInvoiceAmount ?? 1000
  const upstream = config.upstream.replace(/\/$/, '')
  const freeTier = config.freeTier ? new FreeTier(config.freeTier.requestsPerDay) : null

  return {
    freeTier,
    upstream,

    async handle(req: TollBoothRequest): Promise<TollBoothResult> {
      const start = Date.now()
      const path = req.path
      const cost = config.pricing[path]

      // Unpriced routes pass straight through
      if (cost === undefined) {
        return { action: 'pass', upstream, headers: {} }
      }

      // Check for L402 Authorisation header
      const authHeader = req.headers['authorization'] ?? req.headers['Authorization']
      if (authHeader?.startsWith('L402 ')) {
        const result = handleL402Auth(authHeader, config.rootKey, config.storage, cost, defaultAmount)
        if (result.authorised) {
          if (result.creditedAmount) {
            config.onPayment?.({
              timestamp: new Date().toISOString(),
              paymentHash: result.paymentHash!,
              amountSats: result.creditedAmount,
            })
          }
          config.onRequest?.({
            timestamp: new Date().toISOString(),
            endpoint: path,
            satsDeducted: cost,
            remainingBalance: result.remaining,
            latencyMs: Date.now() - start,
            authenticated: true,
          })
          return {
            action: 'proxy',
            upstream,
            headers: { 'X-Credit-Balance': String(result.remaining) },
            creditBalance: result.remaining,
          }
        }
        // Fall through to issue a new challenge if authorisation failed
      }

      // Check free tier
      if (freeTier) {
        const check = freeTier.check(req.ip)
        if (check.allowed) {
          config.onRequest?.({
            timestamp: new Date().toISOString(),
            endpoint: path,
            satsDeducted: 0,
            remainingBalance: 0,
            latencyMs: Date.now() - start,
            authenticated: false,
          })
          return {
            action: 'proxy',
            upstream,
            headers: { 'X-Free-Remaining': String(check.remaining) },
            freeRemaining: check.remaining,
          }
        }
      }

      // Issue L402 challenge
      const invoice = await config.backend.createInvoice(
        defaultAmount,
        `toll-booth: ${defaultAmount} sats credit`,
      )
      const macaroon = mintMacaroon(config.rootKey, invoice.paymentHash, defaultAmount)

      // Store invoice for payment page
      config.storage.storeInvoice(invoice.paymentHash, invoice.bolt11, defaultAmount, macaroon)

      config.onChallenge?.({
        timestamp: new Date().toISOString(),
        endpoint: path,
        amountSats: defaultAmount,
      })

      return {
        action: 'challenge',
        status: 402,
        headers: {
          'WWW-Authenticate': `L402 macaroon="${macaroon}", invoice="${invoice.bolt11}"`,
        },
        body: {
          error: 'Payment required',
          invoice: invoice.bolt11,
          macaroon,
          payment_hash: invoice.paymentHash,
          payment_url: `/invoice-status/${invoice.paymentHash}`,
          amount_sats: defaultAmount,
        },
      }
    },
  }
}

function handleL402Auth(
  authHeader: string,
  rootKey: string,
  storage: StorageBackend,
  cost: number,
  defaultAmount: number,
): { authorised: boolean; remaining: number; paymentHash?: string; creditedAmount?: number } {
  try {
    const token = authHeader.slice(5) // Remove "L402 "
    const colonIdx = token.lastIndexOf(':')
    if (colonIdx === -1) return { authorised: false, remaining: 0 }

    const macaroonBase64 = token.slice(0, colonIdx)
    const preimage = token.slice(colonIdx + 1)

    const result = verifyMacaroon(rootKey, macaroonBase64)
    if (!result.valid || !result.paymentHash) return { authorised: false, remaining: 0 }

    // Verify preimage: sha256(preimage) must equal payment_hash
    const computedHash = createHash('sha256')
      .update(Buffer.from(preimage, 'hex'))
      .digest('hex')
    if (computedHash !== result.paymentHash) return { authorised: false, remaining: 0 }

    // Credit on first valid presentation of preimage
    let creditedAmount: number | undefined
    if (storage.balance(result.paymentHash) === 0) {
      const amount = result.creditBalance ?? defaultAmount
      storage.credit(result.paymentHash, amount)
      creditedAmount = amount
    }

    // Debit credit for this request
    const debit = storage.debit(result.paymentHash, cost)
    if (!debit.success) return { authorised: false, remaining: debit.remaining }

    return { authorised: true, remaining: debit.remaining, paymentHash: result.paymentHash, creditedAmount }
  } catch {
    return { authorised: false, remaining: 0 }
  }
}
