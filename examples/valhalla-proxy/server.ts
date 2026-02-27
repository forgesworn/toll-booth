// examples/valhalla-proxy/server.ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { tollBooth } from 'toll-booth'
import { phoenixdBackend } from 'toll-booth/backends/phoenixd'

const app = new Hono()

const booth = tollBooth({
  backend: phoenixdBackend({
    url: process.env.PHOENIXD_URL ?? 'http://localhost:9740',
    password: process.env.PHOENIXD_PASSWORD ?? '',
  }),
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
  dbPath: process.env.DB_PATH ?? './credits.db',
  onPayment: (event) => {
    console.log(`[payment] ${event.amountSats} sats | hash: ${event.paymentHash}`)
  },
  onRequest: (event) => {
    const auth = event.authenticated ? 'L402' : 'free'
    console.log(`[${auth}] ${event.endpoint} | -${event.satsDeducted} sats | ${event.latencyMs}ms`)
  },
})

app.use('/*', booth)

const port = parseInt(process.env.PORT ?? '3000', 10)
serve({ fetch: app.fetch, port }, () => {
  console.log(`routing proxy listening on :${port}`)
})
