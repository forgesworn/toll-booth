import { randomBytes, createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { Booth, memoryStorage } from '@forgesworn/toll-booth'
import { phoenixdBackend } from '@forgesworn/toll-booth/backends/phoenixd'
import type { LightningBackend, Invoice, InvoiceStatus, StorageBackend } from '@forgesworn/toll-booth'
import type { Announcement } from '402-announce'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MOCK = (process.env.MOCK ?? 'false') === 'true'

interface Joke {
  setup: string
  punchline: string
  topic: string
  quality: 'cracker' | 'standard' | 'premium'
}

const jokes: Joke[] = (JSON.parse(readFileSync(resolve(__dirname, 'jokes.json'), 'utf-8')) as Joke[])
  .filter((j) => j.setup && j.punchline)
  .map((j) => ({ ...j, quality: j.quality ?? 'standard' }))
const topics = [...new Set(jokes.map((j) => j.topic))]

function randomJoke(topic?: string, quality?: string): Joke {
  let pool = topic ? jokes.filter((j) => j.topic === topic) : jokes
  if (quality) pool = pool.filter((j) => j.quality === quality)
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
  const tier = req.headers['x-toll-tier'] as string | undefined ?? 'default'
  const quality = tier === 'premium' ? 'premium'
                : tier === 'standard' ? 'standard'
                : 'cracker'
  const joke = randomJoke(topic, quality)
  res.json({
    setup: joke.setup,
    punchline: joke.punchline,
    topic: joke.topic,
    quality: joke.quality,
    poweredBy: {
      name: 'toll-booth',
      description: 'L402 Lightning payment middleware',
      npm: 'npm install @forgesworn/toll-booth',
      github: 'https://github.com/forgesworn/toll-booth',
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
  pricing: {
    '/api/joke': {
      default: 5,
      standard: 21,
      premium: 42,
    },
  },
  upstream: `http://localhost:${UPSTREAM_PORT}`,
  freeTier: { requestsPerDay: 3 },
  defaultInvoiceAmount: 21,
  creditTiers: [
    { amountSats: 5,   creditSats: 5,   label: '1 cracker joke',   tier: 'default' },
    { amountSats: 21,  creditSats: 21,  label: '1 standard joke',  tier: 'standard' },
    { amountSats: 100, creditSats: 105, label: '5 standard jokes',  tier: 'standard' },
    { amountSats: 42,  creditSats: 42,  label: '1 premium joke',   tier: 'premium' },
    { amountSats: 210, creditSats: 252, label: '6 premium jokes',  tier: 'premium' },
  ],
  rootKey: process.env.ROOT_KEY,
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

let announcement: Announcement | undefined

app.listen(port, async () => {
  const qualityCounts = { cracker: 0, standard: 0, premium: 0 }
  jokes.forEach(j => qualityCounts[j.quality]++)
  console.log(`sats-for-laughs listening on :${port}`)
  console.log(`  topics: ${topics.join(', ')}`)
  console.log(`  jokes loaded: ${jokes.length}`)
  console.log(`  quality: ${qualityCounts.cracker} cracker, ${qualityCounts.standard} standard, ${qualityCounts.premium} premium`)
  console.log(`  pricing: 5/21/42 sats (cracker/standard/premium), 3 free/day`)

  // Announce on Nostr relays for decentralised discovery
  const jokeOutputSchema = {
    type: 'object',
    properties: {
      setup: { type: 'string' },
      punchline: { type: 'string' },
      topic: { type: 'string', enum: topics },
      quality: { type: 'string', enum: ['cracker', 'standard', 'premium'] },
    },
  }
  const announceRelays = (process.env.ANNOUNCE_RELAYS ?? '').split(',').map(r => r.trim()).filter(Boolean)
  const publicUrl = process.env.PUBLIC_URL
  if (!publicUrl) {
    console.warn('  ⚠ PUBLIC_URL not set — skipping Nostr announcement (service will not be discoverable)')
  } else if (announceRelays.length === 0) {
    console.warn('  ⚠ ANNOUNCE_RELAYS not set — skipping Nostr announcement (service will not be discoverable)')
  }
  if (announceRelays.length > 0 && publicUrl) {
    try {
      const { announceService } = await import('402-announce')

      let announceKey = process.env.ANNOUNCE_KEY ?? ''
      if (!announceKey) {
        const keyDir = process.env.DATA_DIR ?? join(homedir(), '.sats-for-laughs')
        const keyPath = join(keyDir, 'announce.key')
        try {
          announceKey = readFileSync(keyPath, 'utf-8').trim()
        } catch {
          announceKey = randomBytes(32).toString('hex')
          mkdirSync(keyDir, { recursive: true })
          writeFileSync(keyPath, announceKey, { mode: 0o600 })
          console.log(`  announce key saved to ${keyPath}`)
        }
      }

      announcement = await announceService({
        secretKey: announceKey,
        relays: announceRelays,
        identifier: `sats-for-laughs-${new URL(publicUrl).hostname}`,
        name: `sats-for-laughs @ ${publicUrl}`,
        url: publicUrl,
        about: 'Lightning-paid joke API — cracker, standard, and premium jokes across 6 topics. Powered by toll-booth.',
        pricing: [
          { capability: 'cracker-joke', price: 5, currency: 'sats' },
          { capability: 'standard-joke', price: 21, currency: 'sats' },
          { capability: 'premium-joke', price: 42, currency: 'sats' },
        ],
        paymentMethods: ['bitcoin-lightning-bolt11'],
        topics: ['jokes', 'humour', 'bitcoin', 'lightning', 'nostr', 'l402'],
        capabilities: [
          {
            name: 'cracker-joke',
            description: 'Bad puns and groaners (5 sats)',
            endpoint: '/api/joke',
            outputSchema: jokeOutputSchema,
          },
          {
            name: 'standard-joke',
            description: 'Solid jokes across 6 topics (21 sats)',
            endpoint: '/api/joke?tier=standard',
            outputSchema: jokeOutputSchema,
          },
          {
            name: 'premium-joke',
            description: 'Top-shelf comedy (42 sats)',
            endpoint: '/api/joke?tier=premium',
            outputSchema: jokeOutputSchema,
          },
        ],
      })
      console.log(`  announced on ${announceRelays.length} relay(s) as ${announcement.pubkey}`)
    } catch (err) {
      console.warn(`  announce failed: ${err instanceof Error ? err.message : err}`)
    }
  }
})

function shutdown() {
  announcement?.close()
  booth.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
