// src/demo.ts
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import QRCode from 'qrcode'
import { memoryStorage } from './storage/memory.js'
import { createTollBooth } from './core/toll-booth.js'
import {
  createWebStandardMiddleware,
  createWebStandardCreateInvoiceHandler,
  createWebStandardInvoiceStatusHandler,
} from './adapters/web-standard.js'
import type { LightningBackend, Invoice, InvoiceStatus } from './types.js'
import type { StorageBackend } from './storage/interface.js'

// -- Colours ------------------------------------------------------------------

const GREEN  = '\x1b[32m'
const CYAN   = '\x1b[36m'
const YELLOW = '\x1b[33m'
const RED    = '\x1b[31m'
const DIM    = '\x1b[2m'
const BOLD   = '\x1b[1m'
const RESET  = '\x1b[0m'

// -- Mock Lightning backend ---------------------------------------------------

function createMockBackend(storage: StorageBackend): LightningBackend {
  return {
    async createInvoice(amountSats: number, memo?: string): Promise<Invoice> {
      const preimage = randomBytes(32)
      const paymentHash = createHash('sha256').update(preimage).digest('hex')
      const bolt11 = `lnbc${amountSats}n1demo${randomBytes(20).toString('hex')}`

      console.log(`  ${GREEN}[payment]${RESET} invoice created: ${amountSats} sats ${DIM}(${memo})${RESET}`)

      // Auto-settle after ~1s to simulate instant payment
      setTimeout(() => {
        storage.settleWithCredit(paymentHash, amountSats, preimage.toString('hex'))
        console.log(`  ${GREEN}[payment]${RESET} invoice settled: ${paymentHash.slice(0, 16)}...`)
      }, 1_000)

      return { bolt11, paymentHash }
    },

    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      const settled = storage.isSettled(paymentHash)
      const preimage = storage.getSettlementSecret(paymentHash)
      return { paid: settled, preimage }
    },
  }
}

// -- Joke API -----------------------------------------------------------------

const jokes = [
  { setup: 'Why do programmers prefer dark mode?', punchline: 'Because light attracts bugs.' },
  { setup: 'Why was the JavaScript developer sad?', punchline: "Because he didn't Node how to Express himself." },
  { setup: "What is a Lightning node's favourite dance?", punchline: 'The channel shuffle.' },
  { setup: 'How do you comfort a JavaScript bug?', punchline: 'You console it.' },
  { setup: 'Why did the developer go broke?', punchline: 'Because he used up all his cache.' },
  { setup: 'Why do Bitcoin maximalists make terrible comedians?', punchline: 'They only accept one punchline.' },
  { setup: 'What did the sat say to the dollar?', punchline: "You're not my type; I only do peer-to-peer." },
  { setup: 'How many Lightning devs does it take to change a light bulb?', punchline: 'None; they just open a channel to one that works.' },
]

// -- Node http <-> Web Standard bridge ----------------------------------------

function toWebRequest(nodeReq: import('node:http').IncomingMessage, body: Buffer): Request {
  const host = nodeReq.headers.host ?? 'localhost'
  const url = new URL(nodeReq.url ?? '/', `http://${host}`)
  const headers = new Headers()
  for (const [key, value] of Object.entries(nodeReq.headers)) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
  }
  const init: RequestInit = { method: nodeReq.method, headers }
  if (nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD' && body.length > 0) {
    init.body = body
  }
  return new Request(url, init)
}

async function sendWebResponse(webRes: Response, nodeRes: import('node:http').ServerResponse): Promise<void> {
  nodeRes.statusCode = webRes.status
  for (const [key, value] of webRes.headers.entries()) {
    nodeRes.setHeader(key, value)
  }
  if (webRes.body) {
    const reader = webRes.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        nodeRes.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  nodeRes.end()
}

// -- Main ---------------------------------------------------------------------

export async function startDemo(): Promise<void> {
  const port = parseInt(process.env.PORT ?? '3000', 10)
  const storage = memoryStorage()
  const backend = createMockBackend(storage)
  const rootKey = randomBytes(32).toString('hex')

  // Tiny upstream joke API on an ephemeral port
  const upstreamPort = await new Promise<number>((resolve) => {
    const upstream = createServer((req, res) => {
      if (req.url?.startsWith('/api/joke')) {
        const joke = jokes[Math.floor(Math.random() * jokes.length)]
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(joke))
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
      }
    })
    upstream.listen(0, () => {
      const addr = upstream.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })

  // Track the current Node request's IP for the getClientIp callback
  let currentClientIp = '127.0.0.1'
  const upstreamUrl = `http://localhost:${upstreamPort}`

  const engine = createTollBooth({
    backend,
    storage,
    rootKey,
    upstream: upstreamUrl,
    pricing: { '/api/joke': 10 },
    defaultInvoiceAmount: 10,
    freeTier: { requestsPerDay: 3 },
    onRequest: (event) => {
      if (event.authenticated) {
        console.log(`  ${CYAN}[L402]${RESET} ${event.endpoint} ${DIM}(-${event.satsDeducted} sats, ${event.remainingBalance} remaining)${RESET}`)
      } else {
        console.log(`  ${YELLOW}[free]${RESET} ${event.endpoint} ${DIM}(${event.remainingBalance} free requests left today)${RESET}`)
      }
    },
    onChallenge: (event) => {
      console.log(`  ${RED}[402]${RESET}  ${event.endpoint} ${DIM}(${event.amountSats} sats required)${RESET}`)
    },
    onPayment: (event) => {
      console.log(`  ${GREEN}[paid]${RESET} credited ${event.amountSats} sats`)
    },
  })

  const middleware = createWebStandardMiddleware({
    engine,
    upstream: upstreamUrl,
    getClientIp: () => currentClientIp,
  })

  const createInvoiceHandler = createWebStandardCreateInvoiceHandler({
    backend,
    storage,
    rootKey,
    tiers: [],
    defaultAmount: 10,
  })

  const invoiceStatusHandler = createWebStandardInvoiceStatusHandler({
    backend,
    storage,
  })

  // Gateway server
  const server = createServer((nodeReq, nodeRes) => {
    const chunks: Buffer[] = []
    nodeReq.on('data', (chunk: Buffer) => chunks.push(chunk))
    nodeReq.on('end', () => {
      const body = Buffer.concat(chunks)
      const webReq = toWebRequest(nodeReq, body)
      currentClientIp = nodeReq.socket.remoteAddress ?? '127.0.0.1'
      const url = new URL(webReq.url)

      void (async () => {
        try {
          let response: Response

          if (url.pathname === '/create-invoice' && nodeReq.method === 'POST') {
            response = await createInvoiceHandler(webReq)
          } else if (url.pathname.startsWith('/invoice-status/') && nodeReq.method === 'GET') {
            response = await invoiceStatusHandler(webReq)
          } else {
            response = await middleware(webReq)

            // Print QR code to terminal on 402 so devs can scan with a wallet
            if (response.status === 402) {
              const cloned = response.clone()
              const body = await cloned.json() as { invoice?: string; payment_url?: string }
              if (body.invoice) {
                const qr = await QRCode.toString(body.invoice.toUpperCase(), { type: 'terminal', small: true })
                console.log('')
                console.log(`  ${BOLD}Scan to pay:${RESET}`)
                console.log(qr)
                console.log(`  ${DIM}Or open: http://localhost:${port}${body.payment_url}${RESET}`)
                console.log('')
              }
            }
          }

          await sendWebResponse(response, nodeRes)
        } catch (err) {
          console.error('  [error]', err)
          nodeRes.statusCode = 500
          nodeRes.end('Internal server error')
        }
      })()
    })
  })

  server.listen(port, () => {
    console.log('')
    console.log(`  ${BOLD}⚡ toll-booth demo${RESET}`)
    console.log(`  ${'─'.repeat(50)}`)
    console.log('')
    console.log(`  ${DIM}Server${RESET}     http://localhost:${port}`)
    console.log(`  ${DIM}Backend${RESET}    Mock Lightning (auto-settles in ~1s)`)
    console.log(`  ${DIM}Storage${RESET}    In-memory (ephemeral)`)
    console.log('')
    console.log(`  ${BOLD}Pricing${RESET}`)
    console.log(`  ${DIM}Route${RESET}            ${DIM}Cost${RESET}         ${DIM}Free tier${RESET}`)
    console.log(`  /api/joke          10 sats      3 reqs/day`)
    console.log('')
    console.log(`  ${BOLD}Try it:${RESET}`)
    console.log(`  ${DIM}$${RESET} curl http://localhost:${port}/api/joke`)
    console.log('')
    console.log(`  ${GREEN}Ready.${RESET} Press Ctrl+C to stop.`)
    console.log('')
  })
}
