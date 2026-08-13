import { beforeEach, describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import type {
  NwcEvent,
  NwcFilter,
  NwcPublishResult,
  NwcSubscription,
  NwcTransport,
} from '@forgesworn/nwc-kit'
import { nwcBackend } from './nwc.js'

const CLIENT_SECRET = '11'.repeat(32)
const SETTLED_INVOICE = 'lnbc10n1pj48ugqpp5urnh55r5z2cjpahduc0ky22mrfajluva8hxg7ujnu5txx3cv3z8qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqgp0xzz'
const PAYMENT_HASH = 'e0e77a507412b120f6ede61f62295b1a7b2ff19d3dcc8f7253e51663470c888e'

class MerchantWalletTransport implements NwcTransport {
  readonly walletSecret = generateSecretKey()
  readonly walletPubkey = getPublicKey(this.walletSecret)
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = []
  queryCount = 0
  payPreimage = 'aa'.repeat(32)
  lookupState = 'settled'
  lookupPreimage = 'aa'.repeat(32)
  invoice = SETTLED_INVOICE
  invoiceHash = PAYMENT_HASH
  injectAttacker = false
  #handler: ((event: NwcEvent) => void) | undefined

  get uri(): string {
    return `nostr+walletconnect://${this.walletPubkey}?relay=${encodeURIComponent('wss://wallet.example')}&secret=${CLIENT_SECRET}`
  }

  async query(): Promise<NwcEvent[]> {
    this.queryCount++
    return [finalizeEvent({
      kind: 13_194,
      created_at: 1_700_000_000,
      tags: [['encryption', 'nip44_v2']],
      content: 'make_invoice lookup_invoice pay_invoice',
    }, this.walletSecret) as NwcEvent]
  }

  subscribe(
    _relays: readonly string[],
    _filter: NwcFilter,
    handlers: { onevent(event: NwcEvent): void },
  ): NwcSubscription {
    this.#handler = handlers.onevent
    return { close: () => { this.#handler = undefined } }
  }

  async publish(relays: readonly string[], request: NwcEvent): Promise<NwcPublishResult[]> {
    const conversationKey = nip44.v2.utils.getConversationKey(this.walletSecret, request.pubkey)
    const payload = JSON.parse(nip44.v2.decrypt(request.content, conversationKey)) as {
      method: string
      params: Record<string, unknown>
    }
    this.requests.push(payload)

    const result = payload.method === 'make_invoice'
      ? { invoice: this.invoice, payment_hash: this.invoiceHash, amount: 1000 }
      : payload.method === 'lookup_invoice'
        ? { state: this.lookupState, payment_hash: PAYMENT_HASH, preimage: this.lookupPreimage }
        : { preimage: this.payPreimage }
    const responsePayload = JSON.stringify({ result_type: payload.method, error: null, result })

    if (this.injectAttacker) {
      const attacker = generateSecretKey()
      const forged = finalizeEvent({
        kind: 23_195,
        created_at: request.created_at + 1,
        tags: [['p', request.pubkey], ['e', request.id]],
        content: nip44.v2.encrypt(responsePayload, nip44.v2.utils.getConversationKey(attacker, request.pubkey)),
      }, attacker) as NwcEvent
      this.#handler?.(forged)
    }

    const response = finalizeEvent({
      kind: 23_195,
      created_at: request.created_at + 1,
      tags: [['p', request.pubkey], ['e', request.id]],
      content: nip44.v2.encrypt(responsePayload, conversationKey),
    }, this.walletSecret) as NwcEvent
    queueMicrotask(() => this.#handler?.(response))
    return relays.map((relay) => ({ relay, accepted: true }))
  }

  close(): void {
    this.#handler = undefined
  }
}

describe('nwcBackend', () => {
  let wallet: MerchantWalletTransport

  beforeEach(() => {
    wallet = new MerchantWalletTransport()
  })

  it('validates the merchant connection eagerly without exposing its secret', () => {
    expect(() => nwcBackend({ nwcUrl: '' })).toThrow()
    expect(() => nwcBackend({ nwcUrl: 'https://not-nwc.example' })).toThrow()
    expect(() => nwcBackend({ nwcUrl: wallet.uri, transport: wallet })).not.toThrow()
  })

  it('creates only an invoice committed to the requested amount and hash', async () => {
    const backend = nwcBackend({ nwcUrl: wallet.uri, transport: wallet })
    await expect(backend.createInvoice(1, 'test memo')).resolves.toEqual({
      bolt11: SETTLED_INVOICE,
      paymentHash: PAYMENT_HASH,
    })
    expect(wallet.requests[0]).toEqual({
      method: 'make_invoice',
      params: { amount: 1000, description: 'test memo' },
    })

    wallet.invoiceHash = 'ff'.repeat(32)
    await expect(backend.createInvoice(1)).rejects.toThrow('violates the requested commitment')
    await expect(backend.createInvoice(Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1)).rejects.toThrow('positive safe integer')
  })

  it('reports settled only when the preimage verifies the requested hash', async () => {
    const backend = nwcBackend({ nwcUrl: wallet.uri, transport: wallet })
    await expect(backend.checkInvoice(PAYMENT_HASH)).resolves.toEqual({ paid: true, preimage: 'aa'.repeat(32) })

    wallet.lookupPreimage = 'ff'.repeat(32)
    await expect(backend.checkInvoice(PAYMENT_HASH)).resolves.toEqual({ paid: false })

    wallet.lookupState = 'pending'
    await expect(backend.checkInvoice(PAYMENT_HASH)).resolves.toEqual({ paid: false })
    await expect(backend.checkInvoice('not-a-hash')).resolves.toEqual({ paid: false })
  })

  it('sends a payment only when the returned preimage settles its BOLT-11 invoice', async () => {
    const backend = nwcBackend({ nwcUrl: wallet.uri, transport: wallet })
    await expect(backend.sendPayment?.(SETTLED_INVOICE)).resolves.toEqual({ preimage: 'aa'.repeat(32) })

    wallet.payPreimage = 'ff'.repeat(32)
    await expect(backend.sendPayment?.(SETTLED_INVOICE)).rejects.toThrow('non-settling preimage')
    await expect(backend.sendPayment?.('lnbc1invalid')).rejects.toThrow('invalid BOLT-11')
  })

  it('ignores a forged relay response and accepts the authenticated wallet response', async () => {
    wallet.injectAttacker = true
    const backend = nwcBackend({ nwcUrl: wallet.uri, transport: wallet })
    await expect(backend.sendPayment?.(SETTLED_INVOICE)).resolves.toEqual({ preimage: 'aa'.repeat(32) })
  })

  it('initialises lazily and reuses discovered wallet capabilities', async () => {
    const backend = nwcBackend({ nwcUrl: wallet.uri, transport: wallet, timeout: 5000 })
    expect(wallet.queryCount).toBe(0)
    await backend.createInvoice(1)
    await backend.checkInvoice(PAYMENT_HASH)
    expect(wallet.queryCount).toBe(1)
  })
})
