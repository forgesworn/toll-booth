// examples/valhalla-proxy/server.ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Booth } from 'toll-booth'
import { phoenixdBackend } from 'toll-booth/backends/phoenixd'

const app = new Hono()
const trustProxy = (process.env.TRUST_PROXY ?? 'false') === 'true'

const backend = phoenixdBackend({
  url: process.env.PHOENIXD_URL ?? 'http://localhost:9740',
  password: process.env.PHOENIXD_PASSWORD ?? '',
})

app.use('/*', cors({
  origin: '*',
  exposeHeaders: ['WWW-Authenticate', 'X-Coverage', 'X-Credit-Balance', 'X-Free-Remaining'],
}))

const booth = new Booth({
  backend,
  pricing: {
    '/route': 2,
    '/isochrone': 5,
    '/sources_to_targets': 10,
  },
  freeTier: {
    requestsPerDay: parseInt(process.env.FREE_TIER_REQUESTS ?? '10', 10),
  },
  upstream: process.env.VALHALLA_URL ?? 'http://localhost:8002',
  defaultInvoiceAmount: parseInt(process.env.DEFAULT_INVOICE_SATS ?? '1000', 10),
  rootKey: process.env.ROOT_KEY,
  dbPath: process.env.DB_PATH ?? './credits.db',
  trustProxy,
  adminToken: process.env.ADMIN_TOKEN,
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
    console.log(`[${auth}] ${event.endpoint} | -${event.satsDeducted} sats | ${event.latencyMs}ms`)
  },
})

app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler)
app.post('/create-invoice', booth.createInvoiceHandler)
app.post('/admin/reset-free-tier', booth.resetFreeTierHandler)
app.use('/*', booth.middleware)

const port = parseInt(process.env.PORT ?? '3000', 10)
serve({ fetch: app.fetch, port }, () => {
  console.log(`routing proxy listening on :${port}`)
})
