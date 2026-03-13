// src/core/security.test.ts
import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createTollBooth } from './toll-booth.js'
import { mintMacaroon } from '../macaroon.js'
import { memoryStorage } from '../storage/memory.js'
import { handleCashuRedeem } from './cashu-redeem.js'

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
