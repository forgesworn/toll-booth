// src/backends/nwc-signature.test.ts
//
// Regression tests for NWC response signature verification.
// A naive NWC client would trust relay-supplied response events without
// verifying their Schnorr signatures — a malicious relay could forge a
// "wallet" response (the authors filter is not authentication) and
// fabricate invoices/preimages. These tests run the REAL client
// (nwc-client.ts, built on nostr-tools) against an in-process fake relay
// that serves forged events.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools'
import * as nip04 from 'nostr-tools/nip04'
import type { NostrEvent } from 'nostr-tools'
import { NWCClient } from './nwc-client.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const NWC_RESPONSE_KIND = 23195
const NWC_INFO_KIND = 13194

// --- Minimal RFC 6455 WebSocket server (text frames only) ---

function encodeFrame(data: string): Buffer {
  const payload = Buffer.from(data, 'utf8')
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

interface FakeRelay {
  url: string
  /** Subscription IDs whose filter targets NWC response events. */
  responseSubIds(): string[]
  /** Request events (kind 23194) published by the client. */
  requestEvents(): NostrEvent[]
  /** Send an event to a subscription. */
  sendEvent(subId: string, event: NostrEvent): void
  close(): Promise<void>
}

function startFakeRelay(): Promise<FakeRelay> {
  const sockets = new Set<Socket>()
  const requestEvents: NostrEvent[] = []
  const responseSubs = new Map<string, Socket>()

  const server: Server = createServer()
  server.on('upgrade', (req, socket: Socket) => {
    const key = req.headers['sec-websocket-key']
    if (!key) {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    sockets.add(socket)

    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      // Parse complete frames
      for (;;) {
        if (buffer.length < 2) return
        const opcode = buffer[0] & 0x0f
        const masked = (buffer[1] & 0x80) !== 0
        let len = buffer[1] & 0x7f
        let offset = 2
        if (len === 126) {
          if (buffer.length < offset + 2) return
          len = buffer.readUInt16BE(offset)
          offset += 2
        } else if (len === 127) {
          if (buffer.length < offset + 8) return
          len = Number(buffer.readBigUInt64BE(offset))
          offset += 8
        }
        const maskLen = masked ? 4 : 0
        if (buffer.length < offset + maskLen + len) return
        let payload = buffer.subarray(offset + maskLen, offset + maskLen + len)
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4)
          payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
        }
        buffer = buffer.subarray(offset + maskLen + len)

        if (opcode === 0x8) {
          socket.end()
          return
        }
        if (opcode === 0x9) {
          // ping → pong
          const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload])
          socket.write(pong)
          continue
        }
        if (opcode !== 0x1) continue

        let msg: unknown[]
        try {
          msg = JSON.parse(payload.toString('utf8'))
        } catch {
          continue
        }
        if (!Array.isArray(msg)) continue

        if (msg[0] === 'REQ' && typeof msg[1] === 'string') {
          const filter = msg[2] as { kinds?: number[] }
          if (filter?.kinds?.includes(NWC_INFO_KIND)) {
            // No wallet info event — forces NIP-04 fallback
            socket.write(encodeFrame(JSON.stringify(['EOSE', msg[1]])))
          } else if (filter?.kinds?.includes(NWC_RESPONSE_KIND)) {
            responseSubs.set(msg[1], socket)
          } else {
            socket.write(encodeFrame(JSON.stringify(['EOSE', msg[1]])))
          }
        } else if (msg[0] === 'EVENT' && msg[1] && typeof msg[1] === 'object') {
          const event = msg[1] as NostrEvent
          requestEvents.push(event)
          socket.write(encodeFrame(JSON.stringify(['OK', event.id, true, ''])))
        }
      }
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `ws://127.0.0.1:${addr.port}`,
        responseSubIds: () => [...responseSubs.keys()],
        requestEvents: () => requestEvents,
        sendEvent(subId, event) {
          const socket = responseSubs.get(subId)
          socket?.write(encodeFrame(JSON.stringify(['EVENT', subId, event])))
        },
        close: () => new Promise((res) => {
          for (const s of sockets) s.destroy()
          server.close(() => res())
        }),
      })
    })
  })
}

// --- Test setup ---

const walletSecret = randomBytes(32)
const walletPubkey = getPublicKey(walletSecret)
const clientSecret = randomBytes(32)
const clientPubkey = getPublicKey(clientSecret)
const attackerSecret = randomBytes(32)

let relay: FakeRelay

async function makeClient(replyTimeout = 800): Promise<NWCClient> {
  relay = await startFakeRelay()
  const nwc = new NWCClient(
    `nostr+walletconnect://${walletPubkey}?relay=${relay.url}&secret=${clientSecret.toString('hex')}`,
  )
  nwc.replyTimeout = replyTimeout
  await nwc.connect()
  return nwc
}

/** Wait until the client has published a request and opened a response sub. */
async function waitForRequest(): Promise<{ request: NostrEvent; subId: string }> {
  for (let i = 0; i < 100; i++) {
    const reqs = relay.requestEvents()
    const subs = relay.responseSubIds()
    if (reqs.length > 0 && subs.length > 0) {
      return { request: reqs[reqs.length - 1], subId: subs[subs.length - 1] }
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('client never published a request')
}

afterEach(async () => {
  await relay?.close()
})

describe('NWC response signature verification (fake relay)', () => {
  // NOTE: verification is layered — nostr-tools' relay layer already
  // verifies event signatures before dispatch, and the NWC client
  // re-checks the author, request reference and signature before trusting
  // a response. These tests guard the whole stack against forged relay
  // responses.

  it('warns once on NIP-04 fallback (no NIP-44 support advertised)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const nwc = await makeClient()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('NIP-04'))
      const callsAfterFirst = warn.mock.calls.length

      // A second client in the same process must NOT warn again
      const relay2 = relay
      const nwc2 = new NWCClient(
        `nostr+walletconnect://${walletPubkey}?relay=${relay2.url}&secret=${randomBytes(32).toString('hex')}`,
      )
      await nwc2.connect()
      expect(warn.mock.calls.length).toBe(callsAfterFirst)
      nwc.close()
      nwc2.close()
    } finally {
      warn.mockRestore()
    }
  })

  it('ignores a forged but validly-signed response from an attacker key', async () => {
    const nwc = await makeClient()

    const invoicePromise = nwc.makeInvoice({ amount: 1000 })
    // Attach a swallow-handler now so a rejection never surfaces as unhandled
    const outcome = invoicePromise.then(
      (tx) => ({ resolved: tx }),
      (err: Error) => ({ rejected: err }),
    )

    const { request, subId } = await waitForRequest()

    // Attacker forges a response: correctly encrypted to the client and
    // VALIDLY SIGNED — but by the attacker's key, not the wallet's.
    const forged = finalizeEvent({
      kind: NWC_RESPONSE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', request.id], ['p', clientPubkey]],
      content: nip04.encrypt(attackerSecret, clientPubkey, JSON.stringify({
        result: { invoice: 'lnbc1forged-by-attacker', payment_hash: 'ab'.repeat(32) },
      })),
    }, attackerSecret)

    relay.sendEvent(subId, forged)

    const result = await outcome
    // Must NOT resolve with the forged payload; the request times out
    expect('rejected' in result).toBe(true)
    if ('rejected' in result) {
      expect(result.rejected.message).toMatch(/Reply timeout/)
    }
    nwc.close()
  })

  it('ignores a response claiming the wallet author with an invalid signature', async () => {
    const nwc = await makeClient()

    const outcome = nwc.makeInvoice({ amount: 1000 }).then(
      (tx) => ({ resolved: tx }),
      (err: Error) => ({ rejected: err }),
    )

    const { request, subId } = await waitForRequest()

    // Claims walletPubkey as author and references the request, but the
    // signature is garbage — a relay serving its own filtered view can
    // produce exactly this.
    const forged: NostrEvent = {
      kind: NWC_RESPONSE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: walletPubkey,
      tags: [['e', request.id], ['p', clientPubkey]],
      content: nip04.encrypt(attackerSecret, clientPubkey, JSON.stringify({
        result: { invoice: 'lnbc1forged', payment_hash: 'cd'.repeat(32) },
      })),
      id: '00'.repeat(32),
      sig: '11'.repeat(64),
    }
    expect(verifyEvent(forged)).toBe(false) // sanity: the forgery is invalid

    relay.sendEvent(subId, forged)

    const result = await outcome
    expect('rejected' in result).toBe(true)
    if ('rejected' in result) {
      expect(result.rejected.message).toMatch(/Reply timeout/)
    }
    nwc.close()
  })

  it('accepts a validly signed response from the wallet key', async () => {
    const nwc = await makeClient()

    const invoicePromise = nwc.makeInvoice({ amount: 1000 })
    const { request, subId } = await waitForRequest()

    const genuine = finalizeEvent({
      kind: NWC_RESPONSE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', request.id], ['p', clientPubkey]],
      content: nip04.encrypt(walletSecret, clientPubkey, JSON.stringify({
        result: { invoice: 'lnbc1genuine', payment_hash: 'ef'.repeat(32) },
      })),
    }, walletSecret)

    relay.sendEvent(subId, genuine)

    const tx = await invoicePromise
    expect(tx.invoice).toBe('lnbc1genuine')
    expect(tx.payment_hash).toBe('ef'.repeat(32))
    nwc.close()
  })
})
