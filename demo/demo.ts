/**
 * Development demo server (requires tsx and Express).
 *
 * For the production demo, use: npx @forgesworn/toll-booth demo
 * The npx version uses the web-standard adapter with zero extra deps.
 *
 * This version runs a tiny upstream joke API on :4444 and a toll-booth
 * gateway on :3000 with a mock Lightning backend that auto-settles
 * invoices after ~1 second. No real Lightning infrastructure required.
 *
 * Usage:  npx tsx demo/demo.ts
 */

import { randomBytes, createHash } from 'node:crypto'
import express from 'express'
import { memoryStorage } from '../src/storage/memory.js'
import { createTollBooth } from '../src/core/toll-booth.js'
import {
  createExpressMiddleware,
  createExpressCreateInvoiceHandler,
  createExpressInvoiceStatusHandler,
} from '../src/adapters/express.js'
import type { LightningBackend, Invoice, InvoiceStatus } from '../src/types.js'
import type { StorageBackend } from '../src/storage/interface.js'

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

      // Auto-settle after ~1 second to simulate instant payment
      setTimeout(() => {
        storage.settleWithCredit(paymentHash, amountSats, preimage.toString('hex'))
        console.log(`  ${GREEN}[payment]${RESET} invoice settled: ${paymentHash.slice(0, 16)}...`)
      }, 1000)

      return { bolt11, paymentHash }
    },

    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      const settled = storage.isSettled(paymentHash)
      const preimage = storage.getSettlementSecret(paymentHash)
      return { paid: settled, preimage }
    },
  }
}

// -- Upstream joke API --------------------------------------------------------

const jokes = [
  { setup: 'Why do programmers prefer dark mode?', punchline: 'Because light attracts bugs.' },
  { setup: 'Why was the JavaScript developer sad?', punchline: "Because he didn't Node how to Express himself." },
  { setup: 'What is a Lightning node\'s favourite dance?', punchline: 'The channel shuffle.' },
  { setup: 'How do you comfort a JavaScript bug?', punchline: 'You console it.' },
  { setup: 'Why did the developer go broke?', punchline: 'Because he used up all his cache.' },
]

function startUpstream(): Promise<void> {
  return new Promise((resolve) => {
    const app = express()
    app.get('/api/joke', (_req, res) => {
      const joke = jokes[Math.floor(Math.random() * jokes.length)]
      res.json(joke)
    })
    app.listen(4444, () => resolve())
  })
}

// -- Main toll-booth server ---------------------------------------------------

async function main() {
  await startUpstream()

  const storage = memoryStorage()
  const backend = createMockBackend(storage)
  const rootKey = randomBytes(32).toString('hex')

  const engine = createTollBooth({
    backend,
    storage,
    rootKey,
    upstream: 'http://localhost:4444',
    pricing: { '/api/joke': 10 },
    defaultInvoiceAmount: 10,
    freeTier: { requestsPerDay: 1 },
    onRequest: (event) => {
      if (event.authenticated) {
        console.log(`  ${CYAN}[L402]${RESET} ${event.endpoint} ${DIM}(-${event.satsDeducted} sats, ${event.remainingBalance} remaining)${RESET}`)
      } else {
        console.log(`  ${YELLOW}[free]${RESET} ${event.endpoint} ${DIM}(${event.remainingBalance} free requests left today)${RESET}`)
      }
    },
    onChallenge: (event) => {
      console.log(`  ${RED}[402]${RESET} ${event.endpoint} ${DIM}(${event.amountSats} sats required)${RESET}`)
    },
    onPayment: (event) => {
      console.log(`  ${GREEN}[payment]${RESET} credited ${event.amountSats} sats`)
    },
  })

  const app = express()
  app.use(express.json())

  // Invoice endpoints
  app.post('/create-invoice', createExpressCreateInvoiceHandler({
    backend,
    storage,
    rootKey,
    tiers: [],
    defaultAmount: 10,
  }))

  app.get('/invoice-status/:paymentHash', createExpressInvoiceStatusHandler({
    backend,
    storage,
  }))

  // L402-gated proxy (trustProxy suppresses warning for localhost demo)
  app.use(createExpressMiddleware({
    engine,
    upstream: 'http://localhost:4444',
    trustProxy: true,
  }))

  app.listen(3000, () => {
    console.log('')
    console.log(`${BOLD}  toll-booth demo${RESET}`)
    console.log(`  ${'─'.repeat(40)}`)
    console.log(`  ${DIM}Upstream${RESET}    http://localhost:4444`)
    console.log(`  ${DIM}Gateway${RESET}     http://localhost:3000`)
    console.log('')
    console.log(`  ${BOLD}Pricing${RESET}`)
    console.log(`  ${DIM}Route${RESET}            ${DIM}Cost${RESET}         ${DIM}Free tier${RESET}`)
    console.log(`  /api/joke          10 sats      1 req/day`)
    console.log('')
    console.log(`  ${GREEN}listening on :3000${RESET}`)
    console.log('')
  })
}

main().catch(console.error)
