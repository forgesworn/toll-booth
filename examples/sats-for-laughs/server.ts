import { randomBytes, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { Booth, memoryStorage } from '@thecryptodonkey/toll-booth'
import { phoenixdBackend } from '@thecryptodonkey/toll-booth/backends/phoenixd'
import type { LightningBackend, Invoice, InvoiceStatus, StorageBackend } from '@thecryptodonkey/toll-booth'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOCK = (process.env.MOCK ?? 'false') === 'true'

interface Joke {
  setup: string
  punchline: string
  topic: string
}

const jokes: Joke[] = (JSON.parse(readFileSync(resolve(__dirname, 'jokes.json'), 'utf-8')) as Joke[])
  .filter((j) => j.setup && j.punchline)
const topics = [...new Set(jokes.map((j) => j.topic))]

function randomJoke(topic?: string): Joke {
  const pool = topic ? jokes.filter((j) => j.topic === topic) : jokes
  if (pool.length === 0) return jokes[Math.floor(Math.random() * jokes.length)]
  return pool[Math.floor(Math.random() * pool.length)]
}

function createMockBackend(storage: StorageBackend): LightningBackend {
  return {
    async createInvoice(amountSats: number, memo?: string): Promise<Invoice> {
      const preimage = randomBytes(32)
      const paymentHash = createHash('sha256').update(preimage).digest('hex')
      const bolt11 = `lnbc${amountSats}n1demo${randomBytes(20).toString('hex')}`
      setTimeout(() => {
        storage.settleWithCredit(paymentHash, amountSats, preimage.toString('hex'))
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

const UPSTREAM_PORT = 4444
const upstream = express()

upstream.get('/api/joke', (req, res) => {
  const topic = typeof req.query.topic === 'string' ? req.query.topic.toLowerCase() : undefined
  const joke = randomJoke(topic)
  res.json({
    setup: joke.setup,
    punchline: joke.punchline,
    topic: joke.topic,
    poweredBy: {
      name: 'toll-booth',
      description: 'L402 Lightning payment middleware',
      npm: 'npm install @thecryptodonkey/toll-booth',
      github: 'https://github.com/TheCryptoDonkey/toll-booth',
    },
  })
})

upstream.listen(UPSTREAM_PORT)

const port = parseInt(process.env.PORT ?? '3000', 10)
const app = express()
app.use(express.json())

// Serve web frontend (before toll-booth middleware so / is not gated)
app.use(express.static(resolve(__dirname, 'public')))

const mockStorage = MOCK ? memoryStorage() : undefined
const backend = MOCK
  ? createMockBackend(mockStorage!)
  : phoenixdBackend({
      url: process.env.PHOENIXD_URL ?? 'http://localhost:9740',
      password: process.env.PHOENIXD_PASSWORD ?? '',
    })

const booth = new Booth({
  adapter: 'express',
  backend,
  ...(mockStorage ? { storage: mockStorage } : { dbPath: process.env.TOLL_BOOTH_DB_PATH ?? '/data/toll-booth.db' }),
  pricing: { '/api/joke': 21 },
  upstream: `http://localhost:${UPSTREAM_PORT}`,
  freeTier: { requestsPerDay: 3 },
  defaultInvoiceAmount: 21,
  creditTiers: [
    { amountSats: 21, creditSats: 21, label: '1 joke' },
    { amountSats: 100, creditSats: 105, label: '5 jokes' },
    { amountSats: 210, creditSats: 252, label: '12 jokes' },
  ],
  rootKey: process.env.ROOT_KEY || randomBytes(32).toString('hex'),
  trustProxy: true,
  onRequest: (event) => {
    const auth = event.authenticated ? 'L402' : 'free'
    console.log(`[${auth}] ${event.endpoint} | -${event.satsDeducted} sats | ${event.remainingBalance} remaining`)
  },
  onChallenge: (event) => {
    console.log(`[402] ${event.endpoint} | ${event.amountSats} sats required`)
  },
  onPayment: (event) => {
    console.log(`[payment] ${event.amountSats} sats credited`)
  },
})

app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as express.RequestHandler)
app.post('/create-invoice', booth.createInvoiceHandler as express.RequestHandler)
app.use('/', booth.middleware as express.RequestHandler)

app.listen(port, () => {
  console.log(`sats-for-laughs listening on :${port}`)
  console.log(`  topics: ${topics.join(', ')}`)
  console.log(`  jokes loaded: ${jokes.length}`)
  console.log(`  pricing: 21 sats/joke (3 free/day)`)
})

function shutdown() {
  booth.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
