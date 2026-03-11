# toll-booth

L402 Lightning payment middleware for Node.js. Gate any HTTP API behind a paywall with a single function call.

Supports **Express 5**, **Deno**, **Bun**, and **Cloudflare Workers** via the Web Standard adapter.

## Features

- **L402 protocol** — industry-standard HTTP 402 payment flow with macaroon credentials
- **Multiple Lightning backends** — Phoenixd, LND, CLN, LNbits, Alby
- **Alternative payment methods** — Nostr Wallet Connect (NWC) and Cashu ecash tokens
- **Cashu-only mode** — no Lightning node required
- **Credit system** — pre-paid balance with volume discount tiers
- **Free tier** — configurable daily allowance per IP
- **Self-service payment page** — QR codes, tier selector, wallet adapter buttons
- **SQLite persistence** — WAL mode, automatic invoice expiry pruning
- **Framework-agnostic core** — use the \`Booth\` facade or wire handlers directly

## Quick start

\`\`\`bash
npm install toll-booth
\`\`\`

### Express

\`\`\`typescript
import express from 'express'
import { Booth } from 'toll-booth'
import { phoenixdBackend } from 'toll-booth/backends/phoenixd'

const app = express()
app.use(express.json())

const booth = new Booth({
  adapter: 'express',
  backend: phoenixdBackend({
    url: 'http://localhost:9740',
    password: process.env.PHOENIXD_PASSWORD!,
  }),
  pricing: { '/api': 10 },           // 10 sats per request
  upstream: 'http://localhost:8080',  // your API
  rootKey: process.env.ROOT_KEY,      // 64 hex chars, required for production
})

app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as express.RequestHandler)
app.post('/create-invoice', booth.createInvoiceHandler as express.RequestHandler)
app.use('/*', booth.middleware as express.RequestHandler)

app.listen(3000)
\`\`\`

### Web Standard (Deno / Bun / Workers)

\`\`\`typescript
import { Booth } from 'toll-booth'
import { lndBackend } from 'toll-booth/backends/lnd'

const booth = new Booth({
  adapter: 'web-standard',
  backend: lndBackend({
    url: 'https://localhost:8080',
    macaroon: process.env.LND_MACAROON!,
  }),
  pricing: { '/api': 5 },
  upstream: 'http://localhost:8080',
})

// Wire booth.middleware, booth.invoiceStatusHandler, booth.createInvoiceHandler
// into your framework's router
\`\`\`

## Configuration

The \`Booth\` constructor accepts:

| Option | Type | Description |
|--------|------|-------------|
| \`adapter\` | \`'express' \| 'web-standard'\` | Framework integration to use |
| \`backend\` | \`LightningBackend\` | Lightning node (optional if using Cashu-only) |
| \`pricing\` | \`Record<string, number>\` | Route pattern → cost in sats |
| \`upstream\` | \`string\` | URL to proxy authorised requests to |
| \`rootKey\` | \`string\` | Macaroon signing key (64 hex chars). Random if omitted |
| \`dbPath\` | \`string\` | SQLite path. Default: \`./toll-booth.db\` |
| \`storage\` | \`StorageBackend\` | Custom storage (alternative to \`dbPath\`) |
| \`freeTier\` | \`{ requestsPerDay: number }\` | Daily free allowance per IP |
| \`strictPricing\` | \`boolean\` | Challenge unpriced routes instead of passing through |
| \`creditTiers\` | \`CreditTier[]\` | Volume discount tiers |
| \`trustProxy\` | \`boolean\` | Trust \`X-Forwarded-For\` / \`X-Real-IP\` |
| \`getClientIp\` | \`(req) => string\` | Custom IP resolver for non-standard runtimes |
| \`responseHeaders\` | \`Record<string, string>\` | Extra headers on every response |
| \`nwcPayInvoice\` | \`(uri, bolt11) => Promise<string>\` | NWC payment callback |
| \`redeemCashu\` | \`(token, hash) => Promise<number>\` | Cashu redemption callback |
| \`invoiceMaxAgeMs\` | \`number\` | Invoice pruning age. Default: 24h. \`0\` to disable |
| \`upstreamTimeout\` | \`number\` | Proxy timeout in ms. Default: 30s |

## Lightning backends

\`\`\`typescript
import { phoenixdBackend } from 'toll-booth/backends/phoenixd'
import { lndBackend } from 'toll-booth/backends/lnd'
import { clnBackend } from 'toll-booth/backends/cln'
import { lnbitsBackend } from 'toll-booth/backends/lnbits'
import { albyBackend } from 'toll-booth/backends/alby'
\`\`\`

Each backend implements the \`LightningBackend\` interface (\`createInvoice\` + \`checkInvoice\`).

## Subpath exports

Tree-shakeable imports for bundlers:

\`\`\`typescript
import { Booth } from 'toll-booth'
import { phoenixdBackend } from 'toll-booth/backends/phoenixd'
import { sqliteStorage } from 'toll-booth/storage/sqlite'
import { memoryStorage } from 'toll-booth/storage/memory'
import { createExpressMiddleware } from 'toll-booth/adapters/express'
import { createWebStandardMiddleware } from 'toll-booth/adapters/web-standard'
\`\`\`

## Payment flow

1. Client requests a priced endpoint without credentials
2. Free tier checked — if allowance remains, request passes through
3. If exhausted → **402** response with BOLT-11 invoice + macaroon
4. Client pays via Lightning, NWC, or Cashu
5. Client sends \`Authorization: L402 <macaroon>:<preimage>\`
6. Macaroon verified, credit deducted, request proxied upstream

## Example deployment

See [\`examples/valhalla-proxy/\`](examples/valhalla-proxy/) for a complete Docker Compose deployment gating a Valhalla routing API behind Lightning payments.

## Licence

[MIT](LICENSE)
