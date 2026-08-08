// src/backends/nwc-client.ts
//
// Minimal Nostr Wallet Connect (NIP-47) client built on nostr-tools
// (SimplePool / finalizeEvent / verifyEvent / NIP-04 / NIP-44 / NIP-19).
//
// Security model:
// - Wallet response events are trusted only after checking the author is the
//   wallet pubkey, the e-tag references the request we sent, AND the Schnorr
//   signature verifies — in that order, BEFORE the cross-relay dedup flag is
//   set, so a forged event cannot suppress the genuine wallet reply. Relay
//   author/#e filters are not authentication (nostr-tools' relay layer also
//   verifies signatures before dispatch; this is defence-in-depth).
// - The wallet info event (kind 13194) used for encryption auto-detection is
//   verified the same way.
// - NIP-44 (v2) is preferred; if the wallet only supports NIP-04 (AES-CBC, no
//   message authentication) a warning is emitted once per process.

import { SimplePool, finalizeEvent, verifyEvent, getPublicKey } from 'nostr-tools'
import type { NostrEvent } from 'nostr-tools'
import * as nip04 from 'nostr-tools/nip04'
import * as nip44 from 'nostr-tools/nip44'
import { decode as nip19decode } from 'nostr-tools/nip19'

// NIP-47 event kinds
const NWC_INFO_KIND = 13194
const NWC_REQUEST_KIND = 23194
const NWC_RESPONSE_KIND = 23195

// NIP-04 fallback warning — emitted once per process. NIP-04 is AES-CBC
// without authentication; NIP-44 is strongly preferred when the wallet
// supports it.
let warnedNip04 = false
function warnNip04Once(): void {
  if (warnedNip04) return
  warnedNip04 = true
  console.warn(
    '[toll-booth] NWC wallet did not advertise NIP-44 support — falling back to NIP-04 ' +
      '(AES-CBC, no message authentication). Responses are signature-verified, but ' +
      'upgrade the wallet for NIP-44 where possible.',
  )
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) {
    throw new NWCError('Invalid hex in connection string', 'INVALID_CONNECTION_STRING')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

export class NWCError extends Error {
  readonly code: string
  constructor(message: string, code = 'INTERNAL') {
    super(message)
    this.name = 'NWCError'
    this.code = code
  }
}

export interface MakeInvoiceParams {
  /** Amount in millisatoshis */
  amount: number
  description?: string
  description_hash?: string
  expiry?: number
}

export interface LookupInvoiceParams {
  payment_hash?: string
  invoice?: string
}

export interface NwcTransaction {
  invoice?: string
  payment_hash?: string
  preimage?: string
  state?: string
  [key: string]: unknown
}

export interface PayInvoiceResult {
  preimage?: string
  [key: string]: unknown
}

type EncryptionType = 'nip04' | 'nip44'

export class NWCClient {
  readonly walletPubkey: string
  readonly relayUrls: string[]
  readonly secretKey: Uint8Array
  readonly publicKey: string

  /** Reply timeout in ms */
  replyTimeout = 60_000
  /** Publish timeout in ms */
  publishTimeout = 5_000

  private readonly pool = new SimplePool()
  private encryptionType?: EncryptionType
  private conversationKey?: Uint8Array
  private _connected = false

  constructor(connectionString: string) {
    const opts = NWCClient.parseConnectionString(connectionString)
    this.walletPubkey = opts.walletPubkey
    this.relayUrls = opts.relayUrls
    this.secretKey = opts.secretKey
    this.publicKey = getPublicKey(this.secretKey)
  }

  static parseConnectionString(connectionString: string): {
    walletPubkey: string
    relayUrls: string[]
    secretKey: Uint8Array
  } {
    // Support both nostr+walletconnect:// and nostrwalletconnect:// formats
    const normalized = connectionString
      .replace('nostrwalletconnect://', 'http://')
      .replace('nostr+walletconnect://', 'http://')
      .replace('nostrwalletconnect:', 'http://')
      .replace('nostr+walletconnect:', 'http://')
    const url = new URL(normalized)
    const walletPubkey = url.host || url.pathname.replace('//', '')
    const relayUrls = url.searchParams.getAll('relay')
    let secret = url.searchParams.get('secret')
    if (!walletPubkey || relayUrls.length === 0 || !secret) {
      throw new NWCError(
        'Invalid NWC connection string: missing pubkey, relay, or secret',
        'INVALID_CONNECTION_STRING',
      )
    }
    // Support nsec-encoded secrets
    if (secret.startsWith('nsec')) {
      const decoded = nip19decode(secret)
      if (decoded.type !== 'nsec') {
        throw new NWCError('Invalid nsec in connection string', 'INVALID_CONNECTION_STRING')
      }
      secret = bytesToHex(decoded.data)
    }
    return { walletPubkey, relayUrls, secretKey: hexToBytes(secret) }
  }

  get connected(): boolean {
    return this._connected
  }

  /** Primary relay URL (first relay in the connection string) */
  get relayUrl(): string {
    return this.relayUrls[0]
  }

  async connect(): Promise<void> {
    // Connect to all relays in parallel; succeed if at least one connects
    const results = await Promise.allSettled(
      this.relayUrls.map((url) => this.pool.ensureRelay(url, { connectionTimeout: 5000 })),
    )
    const anyConnected = results.some((r) => r.status === 'fulfilled')
    if (!anyConnected) {
      const firstError = results.find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined
      throw new NWCError(
        `Failed to connect to relays [${this.relayUrls.join(', ')}]: ` +
          `${firstError?.reason?.message || 'unknown error'}`,
        'CONNECTION_ERROR',
      )
    }
    this._connected = true
    // Auto-detect encryption type
    await this.detectEncryption()
  }

  async makeInvoice(params: MakeInvoiceParams): Promise<NwcTransaction> {
    return this.executeRequest('make_invoice', params)
  }

  async lookupInvoice(params: LookupInvoiceParams): Promise<NwcTransaction> {
    return this.executeRequest('lookup_invoice', params)
  }

  async payInvoice(invoice: string, amount?: number): Promise<PayInvoiceResult> {
    const params: Record<string, unknown> = { invoice }
    if (amount !== undefined) params.amount = amount
    return this.executeRequest('pay_invoice', params)
  }

  close(): void {
    this.pool.close(this.relayUrls)
    this._connected = false
  }

  // --- Private methods ---

  private async detectEncryption(): Promise<void> {
    if (this.encryptionType) return
    // Query the wallet service info event (kind 13194)
    const events = await this.pool.querySync(
      this.relayUrls,
      { kinds: [NWC_INFO_KIND], authors: [this.walletPubkey], limit: 1 },
      { maxWait: 10_000 },
    )
    // The relay supplies the author filter — do not trust it. Only accept
    // an info event verifiably signed by the wallet pubkey.
    const infoEvent = events.find((e) => e.pubkey === this.walletPubkey && verifyEvent(e))
    if (!infoEvent) {
      // Default to nip04 if no verifiable info event found
      this.encryptionType = 'nip04'
      warnNip04Once()
      return
    }
    const encryptionTag = infoEvent.tags.find((t) => t[0] === 'encryption')
    const versionTag = infoEvent.tags.find((t) => t[0] === 'v')
    if (encryptionTag) {
      const encryptions = encryptionTag[1].split(' ')
      if (encryptions.includes('nip44_v2') || encryptions.includes('nip44')) {
        this.encryptionType = 'nip44'
      } else {
        this.encryptionType = 'nip04'
        warnNip04Once()
      }
    } else if (versionTag && versionTag[1].includes('1.0')) {
      this.encryptionType = 'nip44'
    } else {
      this.encryptionType = 'nip04'
      warnNip04Once()
    }
    // Pre-compute conversation key for nip44
    if (this.encryptionType === 'nip44') {
      this.conversationKey = nip44.v2.utils.getConversationKey(this.secretKey, this.walletPubkey)
    }
  }

  private encrypt(content: string): string {
    if (this.encryptionType === 'nip44') {
      if (!this.conversationKey) {
        this.conversationKey = nip44.v2.utils.getConversationKey(this.secretKey, this.walletPubkey)
      }
      return nip44.v2.encrypt(content, this.conversationKey)
    }
    return nip04.encrypt(this.secretKey, this.walletPubkey, content)
  }

  private decrypt(content: string): string {
    try {
      if (this.encryptionType === 'nip44') {
        if (!this.conversationKey) {
          this.conversationKey = nip44.v2.utils.getConversationKey(this.secretKey, this.walletPubkey)
        }
        return nip44.v2.decrypt(content, this.conversationKey)
      }
      return nip04.decrypt(this.secretKey, this.walletPubkey, content)
    } catch (err) {
      throw new NWCError(`Failed to decrypt response: ${(err as Error).message}`, 'DECRYPTION_ERROR')
    }
  }

  private executeRequest<T>(method: string, params: unknown, opts?: { replyTimeout?: number }): Promise<T> {
    if (!this._connected) {
      throw new NWCError('Not connected. Call connect() first.', 'CONNECTION_ERROR')
    }
    return new Promise<T>((resolve, reject) => {
      ;(async () => {
        // Build and encrypt the request
        const command = { method, params }
        const encryptedContent = this.encrypt(JSON.stringify(command))
        const event = finalizeEvent(
          {
            kind: NWC_REQUEST_KIND,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', this.walletPubkey]],
            content: encryptedContent,
          },
          this.secretKey,
        )

        // Subscribe for the response before publishing
        const replyTimeoutMs = opts?.replyTimeout ?? this.replyTimeout
        let responded = false
        const replyTimer = setTimeout(() => {
          sub.close()
          reject(new NWCError(`Reply timeout for ${method}: event ${event.id}`, 'REPLY_TIMEOUT'))
        }, replyTimeoutMs)

        const sub = this.pool.subscribeMany(
          this.relayUrls,
          {
            kinds: [NWC_RESPONSE_KIND],
            authors: [this.walletPubkey],
            '#e': [event.id],
          },
          {
            onevent: async (responseEvent: NostrEvent) => {
              if (responded) return // Deduplicate across relays
              // The relay's author/e-tag filters are not authentication.
              // Ignore forged events: wrong author, wrong request
              // reference, or invalid Schnorr signature. Checked BEFORE
              // setting responded so a forged event cannot suppress the
              // genuine wallet response.
              if (
                responseEvent.pubkey !== this.walletPubkey ||
                !responseEvent.tags.some((t) => t[0] === 'e' && t[1] === event.id) ||
                !verifyEvent(responseEvent)
              ) {
                return
              }
              responded = true
              clearTimeout(replyTimer)
              sub.close()
              try {
                const decryptedContent = this.decrypt(responseEvent.content)
                const response = JSON.parse(decryptedContent)
                if (response.result) {
                  resolve(response.result as T)
                } else if (response.error) {
                  reject(
                    new NWCError(
                      response.error.message || 'Unknown wallet error',
                      response.error.code || 'INTERNAL',
                    ),
                  )
                } else {
                  reject(new NWCError('Unexpected response format', 'INTERNAL'))
                }
              } catch (err) {
                reject(
                  err instanceof NWCError
                    ? err
                    : new NWCError(`Failed to process response: ${(err as Error).message}`, 'INTERNAL'),
                )
              }
            },
          },
        )

        // Publish the request to all relays
        const publishTimer = setTimeout(() => {
          sub.close()
          clearTimeout(replyTimer)
          reject(new NWCError(`Publish timeout for ${method}: event ${event.id}`, 'PUBLISH_TIMEOUT'))
        }, this.publishTimeout)
        try {
          const results = await Promise.allSettled(this.pool.publish(this.relayUrls, event))
          clearTimeout(publishTimer)
          if (!results.some((r) => r.status === 'fulfilled')) {
            clearTimeout(replyTimer)
            sub.close()
            reject(
              new NWCError(`Failed to publish ${method}: no relay accepted the event`, 'PUBLISH_ERROR'),
            )
          }
        } catch (err) {
          clearTimeout(publishTimer)
          clearTimeout(replyTimer)
          sub.close()
          reject(new NWCError(`Failed to publish ${method}: ${(err as Error).message}`, 'PUBLISH_ERROR'))
        }
      })().catch((err) => {
        reject(
          err instanceof NWCError
            ? err
            : new NWCError(`Request failed: ${(err as Error).message}`, 'INTERNAL'),
        )
      })
    })
  }
}
