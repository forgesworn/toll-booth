# toll-booth Cookbook

Quick patterns for common use cases. Each recipe is self-contained.

---

## Recipe 1: Gate a single route, pass everything else free

```typescript
import express from 'express'
import { Booth } from '@forgesworn/toll-booth'
import { phoenixdBackend } from '@forgesworn/toll-booth/backends/phoenixd'

const booth = new Booth({
  adapter: 'express',
  backend: phoenixdBackend({
    url: process.env.PHOENIXD_URL!,
    password: process.env.PHOENIXD_PASSWORD!,
  }),
  pricing: { '/api/generate': 50 },  // only this route costs sats
  upstream: 'http://localhost:8080',
  rootKey: process.env.ROOT_KEY,
})

const app = express()
app.use(express.json())
app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as any)
app.post('/create-invoice', booth.createInvoiceHandler as any)
app.use('/', booth.middleware as any)
app.listen(3000)
// /api/generate → 402 challenge (50 sats)
// /health, /docs, /api/search → pass through free
```

---

## Recipe 2: Gate everything with a free tier

```typescript
const booth = new Booth({
  adapter: 'express',
  backend: phoenixdBackend({ url: process.env.PHOENIXD_URL!, password: process.env.PHOENIXD_PASSWORD! }),
  pricing: {
    '/api/query': 5,
    '/api/generate': 20,
  },
  upstream: 'http://localhost:8080',
  freeTier: { requestsPerDay: 10 },  // 10 free requests per IP per day
  strictPricing: false,               // unpriced routes remain free
  rootKey: process.env.ROOT_KEY,
})
```

Switch to a sats-budget free tier (deducts the route cost, not 1 unit per request):

```typescript
  freeTier: { creditsPerDay: 100 },  // 100 sats budget per IP per day
```

---

## Recipe 3: Volume discount tiers

```typescript
const booth = new Booth({
  adapter: 'express',
  backend: phoenixdBackend({ url: process.env.PHOENIXD_URL!, password: process.env.PHOENIXD_PASSWORD! }),
  pricing: { '/api': 10 },
  upstream: 'http://localhost:8080',
  creditTiers: [
    { amountSats: 1000,  creditSats: 1000,  label: 'Standard' },
    { amountSats: 5000,  creditSats: 5500,  label: 'Pro (10% bonus)' },
    { amountSats: 10000, creditSats: 12000, label: 'Enterprise (20% bonus)' },
  ],
  rootKey: process.env.ROOT_KEY,
})
```

The self-service payment page shows the tier selector automatically. Clients pick a tier when creating an invoice.

---

## Recipe 4: Cashu-only (no Lightning node)

Ideal for serverless, edge, or quick prototypes. No Lightning node, no channels, no liquidity.

```typescript
import { Booth } from '@forgesworn/toll-booth'
import { CashuMint, CashuWallet, getDecodedToken } from '@cashu/cashu-ts'

const ACCEPTED_MINT = 'https://mint.minibits.cash'

const booth = new Booth({
  adapter: 'web-standard',
  redeemCashu: async (tokenStr, paymentHash) => {
    const decoded = getDecodedToken(tokenStr)
    const mint = new CashuMint(ACCEPTED_MINT)
    const wallet = new CashuWallet(mint)
    await wallet.loadMint()
    const { keep, send } = await wallet.send(decoded.token[0].proofs.reduce((s, p) => s + p.amount, 0), decoded.token[0].proofs)
    return keep.reduce((s, p) => s + p.amount, 0)
  },
  pricing: { '/api': 5 },
  upstream: 'http://localhost:8080',
})

// Bun:
Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/cashu-redeem') return (booth.cashuRedeemHandler as any)(req)
    if (url.pathname.startsWith('/invoice-status/')) return (booth.invoiceStatusHandler as any)(req)
    if (url.pathname === '/create-invoice') return (booth.createInvoiceHandler as any)(req)
    return (booth.middleware as any)(req)
  },
})
```

---

## Recipe 5: xcashu (NUT-24) — clients pay via X-Cashu header

No redeem endpoint needed. Clients attach a Cashu token directly in the request header.

```typescript
const booth = new Booth({
  adapter: 'web-standard',
  xcashu: {
    mints: ['https://mint.minibits.cash'],
    unit: 'sat',
    onProofsReceived: (proofs) => {
      console.log(`Received ${proofs.reduce((s, p) => s + p.amount, 0)} sats via xcashu`)
    },
  },
  pricing: { '/api': 10 },
  upstream: 'http://localhost:8080',
})
// Client sends: X-Cashu: cashuBo_... (a Cashu token string)
```

---

## Recipe 6: Multi-rail (Lightning + xcashu + x402 simultaneously)

The client uses whichever rail it supports. Credits, free tiers, and volume discounts apply identically across all rails.

```typescript
import { X402Facilitator } from '@forgesworn/toll-booth'

const booth = new Booth({
  adapter: 'express',
  backend: phoenixdBackend({ url: process.env.PHOENIXD_URL!, password: process.env.PHOENIXD_PASSWORD! }),
  xcashu: { mints: ['https://mint.minibits.cash'] },
  x402: {
    receiverAddress: process.env.RECEIVER_ADDRESS!,  // EVM address for USDC
    network: 'base',
    facilitator: myFacilitator,
  },
  pricing: { '/api': { sats: 10, usd: 1 } },  // dual-currency pricing
  upstream: 'http://localhost:8080',
  rootKey: process.env.ROOT_KEY,
})
// 402 response includes: WWW-Authenticate (L402), X-Cashu, and Payment-Required (x402) headers
```

---

## Recipe 7: Hono (use createHonoTollBooth, not Booth)

For Hono, do not use the `Booth` class. Use `createHonoTollBooth()` from the hono subpath instead.

```typescript
import { Hono } from 'hono'
import { createTollBooth } from '@forgesworn/toll-booth'
import { createHonoTollBooth } from '@forgesworn/toll-booth/hono'
import type { TollBoothEnv } from '@forgesworn/toll-booth/hono'
import { phoenixdBackend } from '@forgesworn/toll-booth/backends/phoenixd'
import { sqliteStorage } from '@forgesworn/toll-booth/storage/sqlite'

const backend = phoenixdBackend({ url: process.env.PHOENIXD_URL!, password: process.env.PHOENIXD_PASSWORD! })
const storage = sqliteStorage({ path: './toll-booth.db' })
const rootKey = process.env.ROOT_KEY!

const engine = createTollBooth({
  pricing: { '/api': 10 },
  backend,
  storage,
  rootKey,
})

const { authMiddleware, createPaymentApp } = createHonoTollBooth({ engine })

const paymentApp = createPaymentApp({
  storage,
  rootKey,
  backend,
  tiers: [{ amountSats: 1000, creditSats: 1000, label: 'Standard' }],
  defaultAmount: 1000,
})

const app = new Hono<TollBoothEnv>()
app.route('/pay', paymentApp)   // /pay/create-invoice, /pay/invoice-status/:paymentHash
app.use('/*', authMiddleware)

app.get('/api/data', (c) => {
  const balance = c.get('tollBoothCreditBalance')
  return c.json({ data: 'paid content', balance })
})

export default app
```

---

## Recipe 8: Custom macaroon caveats (restrict by model or tier)

```typescript
// Client requests an invoice with caveats:
// POST /create-invoice
// { "amountSats": 1000, "caveats": ["model = llama3", "tier = basic", "expires = 2026-12-31T00:00:00Z"] }

// toll-booth forwards them to your upstream as headers:
// X-Toll-Caveat-Model: llama3
// X-Toll-Caveat-Tier: basic

// Your upstream reads and enforces them. Caveats are chosen by whoever
// requested the invoice, so treat them as restrictions only; never grant
// anything because a caveat is present. Client-sent X-Toll-* headers are
// stripped before proxying.
app.post('/api/generate', (req, res) => {
  const model = req.headers['x-toll-caveat-model'] as string | undefined
  const tier  = req.headers['x-toll-caveat-tier'] as string | undefined
  if (tier === 'basic' && req.body.stream) {
    return res.status(403).json({ error: 'Streaming not available on basic tier' })
  }
  // proceed with model routing...
})
```

Built-in caveats enforced automatically by toll-booth (upstream never sees them):
- `route = /api/*` — path restriction with wildcard
- `expires = 2026-06-01T00:00:00Z` — ISO 8601 expiry
- `ip = 203.0.113.1` — bind to client IP

---

## Recipe 9: Observability via event hooks

```typescript
const booth = new Booth({
  adapter: 'express',
  backend: phoenixdBackend({ url: process.env.PHOENIXD_URL!, password: process.env.PHOENIXD_PASSWORD! }),
  pricing: { '/api': 10 },
  upstream: 'http://localhost:8080',

  onPayment: ({ amountSats, rail, paymentHash }) => {
    metrics.increment('payments', { rail })
    metrics.gauge('revenue_sats', amountSats)
  },
  onRequest: ({ endpoint, satsDeducted, remainingBalance, latencyMs }) => {
    metrics.histogram('request_latency', latencyMs, { endpoint })
    if (remainingBalance < 100) {
      // warn client they are running low — see X-Credit-Balance header
    }
  },
  onChallenge: ({ endpoint, amountSats }) => {
    metrics.increment('challenges', { endpoint })
  },
})
// Hooks fire synchronously — keep them fast or defer with setImmediate.
```

---

## Recipe 10: In-memory storage for testing

```typescript
import { Booth } from '@forgesworn/toll-booth'
import { memoryStorage } from '@forgesworn/toll-booth/storage/memory'

const booth = new Booth({
  adapter: 'express',
  backend: myMockBackend,
  pricing: { '/api': 10 },
  upstream: 'http://localhost:9999',
  storage: memoryStorage(),  // no SQLite, no disk I/O
})
// Suitable for unit tests and ephemeral deployments.
// State is lost on restart.
```

---

## Recipe 11: Custom LightningBackend

Implement your own backend for any Lightning node with an HTTP API.

```typescript
import type { LightningBackend } from '@forgesworn/toll-booth'

const myBackend: LightningBackend = {
  async createInvoice(amountSats, memo) {
    const res = await fetch('https://my-node/v1/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.NODE_TOKEN}` },
      body: JSON.stringify({ value_msat: amountSats * 1000, memo }),
    })
    const data = await res.json()
    return { bolt11: data.payment_request, paymentHash: data.r_hash }
  },
  async checkInvoice(paymentHash) {
    const res = await fetch(`https://my-node/v1/invoices/${paymentHash}`, {
      headers: { Authorization: `Bearer ${process.env.NODE_TOKEN}` },
    })
    const data = await res.json()
    return { paid: data.settled, preimage: data.r_preimage }
  },
}
```

---

## Recipe 12: Gate a non-JS upstream (sidecar pattern)

toll-booth proxies to any HTTP service regardless of language.

```typescript
// Your Python / Go / C++ API runs at http://localhost:8080
// toll-booth handles auth and payment, passes clean requests through

const booth = new Booth({
  adapter: 'express',
  backend: phoenixdBackend({ url: process.env.PHOENIXD_URL!, password: process.env.PHOENIXD_PASSWORD! }),
  pricing: {
    '/api/route': 2,    // routing query: 2 sats
    '/api/match': 5,    // map-matching: 5 sats
  },
  upstream: 'http://localhost:8080',
  rootKey: process.env.ROOT_KEY,
})
// Upstream receives: normal HTTP request + X-Credit-Balance header
// See examples/valhalla-proxy/ for Docker Compose reference
```

---

## Common pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| All macaroons invalid after restart | `rootKey` not set — random key generated per start | Set `ROOT_KEY` env var to a persistent 64-char hex string |
| Free routes unexpectedly charging | Middleware mounted before route handlers | Mount invoice/status handlers before `booth.middleware`; check `strictPricing` |
| Credits not persisting | Using `memoryStorage()` in production | Switch to `sqliteStorage()` with a persistent `dbPath` |
| Free tier not isolating per IP | `trustProxy` false behind a reverse proxy | Set `trustProxy: true` or provide `getClientIp` |
| Cashu redemptions failing after crash | `redeemCashu` not idempotent for same `paymentHash` | Make redemption idempotent; call `booth.recoverPendingClaims()` on startup |
| Hono: `adapter: 'hono'` throws | `AdapterType` only accepts `'express'` or `'web-standard'` | Use `createHonoTollBooth()` from `@forgesworn/toll-booth/hono` instead of `Booth` |
