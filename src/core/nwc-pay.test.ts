import { describe, it, expect, vi } from 'vitest'
import { handleNwcPay } from './nwc-pay.js'
import { memoryStorage } from '../storage/memory.js'
import type { NwcPayDeps } from './nwc-pay.js'

function createDeps(overrides?: Partial<NwcPayDeps>): NwcPayDeps {
  const storage = memoryStorage()
  return {
    nwcPay: vi.fn().mockResolvedValue('preimage_hex'),
    storage,
    ...overrides,
  }
}

describe('handleNwcPay', () => {
  it('returns 400 for missing fields', async () => {
    const deps = createDeps()
    const result = await handleNwcPay(deps, { nwcUri: '', bolt11: '', paymentHash: '', statusToken: '' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.status).toBe(400)
  })

  it('returns 400 for invalid payment hash', async () => {
    const deps = createDeps()
    const result = await handleNwcPay(deps, {
      nwcUri: 'nostr+walletconnect://abc',
      bolt11: 'lnbc1000n1...',
      paymentHash: 'not-a-hash',
      statusToken: 'tok123',
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.status).toBe(400)
  })

  it('returns 400 for unknown invoice', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    const result = await handleNwcPay(deps, {
      nwcUri: 'nostr+walletconnect://abc',
      bolt11: 'lnbc1000n1...',
      paymentHash: hash,
      statusToken: 'tok123',
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.status).toBe(400)
  })

  it('returns 400 if bolt11 does not match stored invoice', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    deps.storage.storeInvoice(hash, 'lnbc_stored', 1000, 'mac', 'tok123')
    const result = await handleNwcPay(deps, {
      nwcUri: 'nostr+walletconnect://abc',
      bolt11: 'lnbc_different',
      paymentHash: hash,
      statusToken: 'tok123',
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.status).toBe(400)
  })

  it('returns preimage on success', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    deps.storage.storeInvoice(hash, 'lnbc_stored', 1000, 'mac', 'tok123')
    const result = await handleNwcPay(deps, {
      nwcUri: 'nostr+walletconnect://abc',
      bolt11: 'lnbc_stored',
      paymentHash: hash,
      statusToken: 'tok123',
    })
    expect(result).toEqual({ success: true, preimage: 'preimage_hex' })
    expect(deps.nwcPay).toHaveBeenCalledWith('nostr+walletconnect://abc', 'lnbc_stored')
  })

  it('rejects oversized nwcUri', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    deps.storage.storeInvoice(hash, 'lnbc_stored', 1000, 'mac', 'tok123')
    const result = await handleNwcPay(deps, {
      nwcUri: 'x'.repeat(2049),
      bolt11: 'lnbc_stored',
      paymentHash: hash,
      statusToken: 'tok123',
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.status).toBe(400)
  })

  it('rejects oversized statusToken', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    deps.storage.storeInvoice(hash, 'lnbc_stored', 1000, 'mac', 'tok123')
    const result = await handleNwcPay(deps, {
      nwcUri: 'nostr+walletconnect://abc',
      bolt11: 'lnbc_stored',
      paymentHash: hash,
      statusToken: 'x'.repeat(129),
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.status).toBe(400)
  })

  it('rejects nwcUri without nostr+walletconnect:// scheme', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    deps.storage.storeInvoice(hash, 'lnbc_stored', 1000, 'mac', 'tok123')
    const result = await handleNwcPay(deps, {
      nwcUri: 'wss://evil-internal-service.local',
      bolt11: 'lnbc_stored',
      paymentHash: hash,
      statusToken: 'tok123',
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.status).toBe(400)
    if (!result.success) expect(result.error).toMatch(/nostr\+walletconnect/)
  })

  it('rejects http:// nwcUri (SSRF prevention)', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    deps.storage.storeInvoice(hash, 'lnbc_stored', 1000, 'mac', 'tok123')
    const result = await handleNwcPay(deps, {
      nwcUri: 'http://169.254.169.254/latest/meta-data/',
      bolt11: 'lnbc_stored',
      paymentHash: hash,
      statusToken: 'tok123',
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.status).toBe(400)
  })

  it('returns 500 when nwcPay throws', async () => {
    const deps = createDeps({
      nwcPay: vi.fn().mockRejectedValue(new Error('wallet offline')),
    })
    const hash = 'a'.repeat(64)
    deps.storage.storeInvoice(hash, 'lnbc_stored', 1000, 'mac', 'tok123')
    const result = await handleNwcPay(deps, {
      nwcUri: 'nostr+walletconnect://abc',
      bolt11: 'lnbc_stored',
      paymentHash: hash,
      statusToken: 'tok123',
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.status).toBe(500)
  })
})
