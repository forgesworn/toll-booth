// examples/valhalla-proxy/server.ts
import express from 'express'
import cors from 'cors'
import { Booth } from '@forgesworn/toll-booth'
import { phoenixdBackend } from '@forgesworn/toll-booth/backends/phoenixd'

const app = express()
const trustProxy = (process.env.TRUST_PROXY ?? 'false') === 'true'

const backend = phoenixdBackend({
  url: process.env.PHOENIXD_URL ?? 'http://localhost:9740',
  password: process.env.PHOENIXD_PASSWORD ?? '',
})

app.use(cors({
  origin: '*',
  exposedHeaders: ['WWW-Authenticate', 'X-Coverage', 'X-Credit-Balance', 'X-Free-Remaining'],
}))

app.use(express.json({ limit: '64kb' }))

const booth = new Booth({
  adapter: 'express',
  backend,
  pricing: {
    '/route': 2,
    '/isochrone': 5,
    '/sources_to_targets': 10,
  },
  strictPricing: true,
  freeTier: {
    requestsPerDay: parseInt(process.env.FREE_TIER_REQUESTS ?? '10', 10),
  },
  upstream: process.env.VALHALLA_URL ?? 'http://localhost:8002',
  responseHeaders: { 'X-Coverage': 'GB' },
  defaultInvoiceAmount: parseInt(process.env.DEFAULT_INVOICE_SATS ?? '1000', 10),
  dbPath: process.env.TOLL_BOOTH_DB_PATH ?? './toll-booth.db',
  rootKey: process.env.ROOT_KEY,
  trustProxy,
  creditTiers: [
    { amountSats: 1_000,   creditSats: 1_000,   label: 'Starter' },
    { amountSats: 10_000,  creditSats: 11_100,  label: 'Pro' },
    { amountSats: 100_000, creditSats: 125_000, label: 'Business' },
  ],
  onPayment: (event) => {
    console.log(`[payment] ${event.amountSats} sats | hash: ${event.paymentHash}`)
  },
  onRequest: (event) => {
    const auth = event.authenticated ? 'L402' : 'free'
    console.log(`[${auth}] ${event.endpoint} | ${event.clientIp} | -${event.satsDeducted} sats | ${event.latencyMs}ms`)
  },
})

app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as any)
app.post('/create-invoice', booth.createInvoiceHandler as any)
app.use('/', booth.middleware as any)

// Daily free-tier reset
const freeTierTimer = setInterval(() => {
  booth.resetFreeTier()
  console.log('[free-tier] daily counters reset')
}, 86_400_000)

const port = parseInt(process.env.PORT ?? '3000', 10)
const server = app.listen(port, () => {
  console.log(`routing proxy listening on :${port}`)
})

function shutdown() {
  console.log('shutting down…')
  clearInterval(freeTierTimer)
  server.close()
  booth.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
