import { blake2b } from '@noble/hashes/blake2.js'
import type { TollBoothRequest } from './types.js'
import type { PaymentRail, PriceInfo, ChallengeFragment, RailVerifyResult } from './payment-rail.js'

/**
 * Configuration for the Nano (XNO) payment rail.
 *
 * A payment is a confirmed send block to the operator's own address. There
 * is no facilitator: the rail looks the block up over the node RPC
 * (`blocks_info`) and checks destination, amount and confirmation itself.
 */
export interface NanoRailConfig {
  /** Operator's Nano address (`nano_` or `xrb_`) that receives payments. */
  address: string
  /**
   * Fixed exchange rate: raw (10^-30 XNO) per US cent. Provide this or
   * `quoteRawPerCent`. toll-booth ships no price oracle.
   */
  rawPerCent?: bigint | string
  /** Operator-supplied rate source, called per challenge and per verification. */
  quoteRawPerCent?: () => Promise<bigint | string>
  /** Node RPC endpoint. Default: https://rpc.nano.to */
  rpcUrl?: string
  /** Injectable fetch (tests, custom agents). Default: global fetch. */
  fetch?: typeof fetch
  /** RPC timeout in milliseconds. Default: 10000. */
  rpcTimeoutMs?: number
  /**
   * Reject blocks the node first saw more than this many seconds ago, so
   * older sends to the address cannot be presented as fresh payments.
   * Default: 3600.
   */
  maxBlockAgeSeconds?: number
}

export const NANO_DEFAULT_RPC_URL = 'https://rpc.nano.to'

const NANO_ALPHABET = '13456789abcdefghijkmnopqrstuwxyz'
const ADDRESS_RE = /^(?:nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/
const BLOCK_HASH_RE = /^[0-9A-Fa-f]{64}$/

/** Decode a base32 string in the Nano alphabet to a bigint. */
function decodeBase32(chars: string): bigint {
  let value = 0n
  for (const c of chars) {
    const index = NANO_ALPHABET.indexOf(c)
    if (index < 0) throw new Error('invalid character')
    value = (value << 5n) | BigInt(index)
  }
  return value
}

function bigintToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn)
    value >>= 8n
  }
  return bytes
}

/**
 * Decode a Nano address to its 32-byte public key, verifying the
 * blake2b-40 checksum. Returns undefined for any invalid address.
 */
export function decodeNanoAddress(address: string): Uint8Array | undefined {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) return undefined
  const body = address.slice(address.indexOf('_') + 1)
  // 52 characters carry 260 bits: 4 zero padding bits then the 256-bit key.
  const key = decodeBase32(body.slice(0, 52))
  if (key >> 256n !== 0n) return undefined
  const publicKey = bigintToBytes(key, 32)
  const checksum = bigintToBytes(decodeBase32(body.slice(52)), 5)
  const expected = blake2b(publicKey, { dkLen: 5 }).reverse()
  for (let i = 0; i < 5; i++) {
    if (checksum[i] !== expected[i]) return undefined
  }
  return publicKey
}

export function isValidNanoAddress(address: string): boolean {
  return decodeNanoAddress(address) !== undefined
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/** Parse an operator-supplied rate; must be a positive integer number of raw. */
function parseRate(rate: bigint | string): bigint {
  const value = typeof rate === 'bigint' ? rate : (/^\d+$/.test(rate) ? BigInt(rate) : -1n)
  if (value <= 0n) throw new Error('Nano rate must be a positive integer of raw per cent')
  return value
}

/** Raw required for a USD price in cents, rounded up. BigInt maths only. */
export function requiredRaw(usdCents: number, rawPerCent: bigint): bigint {
  // Prices in cents may be fractional; scale to millionths of a cent.
  const micro = BigInt(Math.round(usdCents * 1_000_000))
  return (micro * rawPerCent + 999_999n) / 1_000_000n
}

interface BlockInfo {
  amount?: unknown
  confirmed?: unknown
  subtype?: unknown
  local_timestamp?: unknown
  contents?: { type?: unknown; link_as_account?: unknown }
}

export function createNanoRail(config: NanoRailConfig): PaymentRail {
  const publicKey = decodeNanoAddress(config.address)
  if (!publicKey) {
    throw new Error('Nano rail: address is not a valid Nano address')
  }
  const payeeKey = toHex(publicKey)
  if ((config.rawPerCent === undefined) === (config.quoteRawPerCent === undefined)) {
    throw new Error('Nano rail: provide exactly one of rawPerCent or quoteRawPerCent')
  }
  const fixedRate = config.rawPerCent !== undefined ? parseRate(config.rawPerCent) : undefined
  const rpcUrl = config.rpcUrl ?? NANO_DEFAULT_RPC_URL
  const doFetch = config.fetch ?? fetch
  const rpcTimeoutMs = config.rpcTimeoutMs ?? 10_000
  const maxBlockAgeSeconds = config.maxBlockAgeSeconds ?? 3600

  async function rate(): Promise<bigint> {
    return fixedRate ?? parseRate(await config.quoteRawPerCent!())
  }

  function hasUsdPrice(price?: PriceInfo): price is PriceInfo & { usd: number } {
    return price?.usd !== undefined && Number.isFinite(price.usd) && price.usd > 0
  }

  async function fetchBlock(hash: string): Promise<BlockInfo | undefined> {
    const res = await doFetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'blocks_info', json_block: 'true', hashes: [hash] }),
      signal: AbortSignal.timeout(rpcTimeoutMs),
    })
    if (!res.ok) return undefined
    const data = await res.json() as { blocks?: Record<string, BlockInfo> }
    const block = data?.blocks?.[hash]
    return block && typeof block === 'object' ? block : undefined
  }

  return {
    type: 'nano',
    creditSupported: false,

    canChallenge(price: PriceInfo): boolean {
      return hasUsdPrice(price)
    },

    detect(req: TollBoothRequest): boolean {
      return req.headers['x-nano-block'] !== undefined
    },

    async challenge(_route: string, price: PriceInfo): Promise<ChallengeFragment> {
      let amount: bigint
      try {
        amount = requiredRaw(price.usd!, await rate())
      } catch {
        // No rate available: leave Nano out of this challenge rather than
        // failing the whole 402.
        return { headers: {}, body: {} }
      }
      const uri = `nano:${config.address}?amount=${amount}`
      return {
        headers: { 'X-Nano': uri },
        body: {
          nano: {
            address: config.address,
            amount_raw: amount.toString(),
            amount_usd: price.usd,
            uri,
          },
        },
      }
    },

    async verify(req: TollBoothRequest, price?: PriceInfo): Promise<RailVerifyResult> {
      const fail: RailVerifyResult = { authenticated: false, paymentId: '', mode: 'per-request', currency: 'usd' }

      const header = req.headers['x-nano-block']
      if (typeof header !== 'string' || !BLOCK_HASH_RE.test(header)) return fail
      // Fail closed when the route has no USD price to check against.
      if (!hasUsdPrice(price)) return fail
      // Upper-case so case variants of one hash share a settlement key.
      const hash = header.toUpperCase()

      try {
        const [block, rawPerCent] = await Promise.all([fetchBlock(hash), rate()])
        if (!block) return fail

        if (block.confirmed !== 'true' && block.confirmed !== true) return fail
        if (block.subtype !== 'send' || block.contents?.type !== 'state') return fail

        const destination = block.contents.link_as_account
        const destinationKey = typeof destination === 'string' ? decodeNanoAddress(destination) : undefined
        if (!destinationKey || toHex(destinationKey) !== payeeKey) return fail

        if (typeof block.amount !== 'string' || !/^\d{1,40}$/.test(block.amount)) return fail
        const amount = BigInt(block.amount)
        if (amount < requiredRaw(price.usd, rawPerCent)) return fail

        if (Number.isFinite(maxBlockAgeSeconds)) {
          const seen = typeof block.local_timestamp === 'string' ? Number(block.local_timestamp) : NaN
          if (!Number.isFinite(seen) || seen <= 0) return fail
          if (Date.now() / 1000 - seen > maxBlockAgeSeconds) return fail
        }

        return {
          authenticated: true,
          // Namespaced so a block hash never shares a settlement key with
          // a Lightning payment hash. The engine settles it once.
          paymentId: `nano:${hash}`,
          mode: 'per-request',
          currency: 'usd',
        }
      } catch {
        return fail
      }
    },
  }
}
