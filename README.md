# toll-booth

[![MIT licence](https://img.shields.io/badge/licence-MIT-blue.svg)](./LICENSE)
[![Nostr](https://img.shields.io/badge/Nostr-Zap%20me-purple)](https://primal.net/p/npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2)

L402 Lightning payment middleware for Node.js. Gate any HTTP API behind a paywall with a single function call.

Supports **Express 5**, **Deno**, **Bun**, and **Cloudflare Workers** via the Web Standard adapter.

**[Why L402?](docs/vision.md)** — the case for permissionless, machine-to-machine payments on the web.

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
npm install @thecryptodonkey/toll-booth
\`\`\`

### Express

\`\`\`typescript
import express from 'express'
import { Booth } from '@thecryptodonkey/toll-booth'
import { phoenixdBackend } from '@thecryptodonkey/toll-booth/backends/phoenixd'

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
app.use('/', booth.middleware as express.RequestHandler)

app.listen(3000)
\`\`\`

### Web Standard (Deno / Bun / Workers)

\`\`\`typescript
import { Booth } from '@thecryptodonkey/toll-booth'
import { lndBackend } from '@thecryptodonkey/toll-booth/backends/lnd'

const booth = new Booth({
  adapter: 'web-standard',
  backend: lndBackend({
    url: 'https://localhost:8080',
    macaroon: process.env.LND_MACAROON!,
  }),
  pricing: { '/api': 5 },
  upstream: 'http://localhost:8080',
})

// Deno example
Deno.serve({ port: 3000 }, async (req: Request) => {
  const url = new URL(req.url)
  if (url.pathname.startsWith('/invoice-status/'))
    return booth.invoiceStatusHandler(req)
  if (url.pathname === '/create-invoice' && req.method === 'POST')
    return booth.createInvoiceHandler(req)
  return booth.middleware(req)
})
\`\`\`

### Cashu-only (no Lightning node)

\`\`\`typescript
import { Booth } from '@thecryptodonkey/toll-booth'

const booth = new Booth({
  adapter: 'web-standard',
  redeemCashu: async (token, paymentHash) => {
    // Verify and redeem the ecash token with your Cashu mint
    // Return the amount redeemed in satoshis
    return amountRedeemed
  },
  pricing: { '/api': 5 },
  upstream: 'http://localhost:8080',
})
\`\`\`

No Lightning node, no channels, no liquidity management. Ideal for serverless and edge deployments.

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
import { phoenixdBackend } from '@thecryptodonkey/toll-booth/backends/phoenixd'
import { lndBackend } from '@thecryptodonkey/toll-booth/backends/lnd'
import { clnBackend } from '@thecryptodonkey/toll-booth/backends/cln'
import { lnbitsBackend } from '@thecryptodonkey/toll-booth/backends/lnbits'
import { albyBackend } from '@thecryptodonkey/toll-booth/backends/alby'
\`\`\`

Each backend implements the `LightningBackend` interface (`createInvoice` + `checkInvoice`).

| Backend | Status | Notes |
|---------|--------|-------|
| Phoenixd | Stable | Simplest self-hosted option |
| LND | Stable | Industry standard |
| CLN | Stable | Core Lightning REST API |
| LNbits | Stable | Any LNbits instance — self-hosted or hosted |
| Alby (NWC) | Experimental | JSON relay transport is unauthenticated; only enable with `allowInsecureRelay: true` for local testing or a fully trusted relay |

## Subpath exports

Tree-shakeable imports for bundlers:

\`\`\`typescript
import { Booth } from '@thecryptodonkey/toll-booth'
import { phoenixdBackend } from '@thecryptodonkey/toll-booth/backends/phoenixd'
import { sqliteStorage } from '@thecryptodonkey/toll-booth/storage/sqlite'
import { memoryStorage } from '@thecryptodonkey/toll-booth/storage/memory'
import { createExpressMiddleware } from '@thecryptodonkey/toll-booth/adapters/express'
import { createWebStandardMiddleware } from '@thecryptodonkey/toll-booth/adapters/web-standard'
\`\`\`

## Payment flow

1. Client requests a priced endpoint without credentials
2. Free tier checked — if allowance remains, request passes through
3. If exhausted → **402** response with BOLT-11 invoice + macaroon
4. Client pays via Lightning, NWC, or Cashu
5. Client sends \`Authorization: L402 <macaroon>:<preimage>\`
6. Macaroon verified, credit deducted, request proxied upstream

## Why not Aperture?

[Aperture](https://github.com/lightninglabs/aperture) is Lightning Labs' production L402 reverse proxy. It's battle-tested and feature-rich. Use it if you can.

| | Aperture | toll-booth |
|---|---|---|
| **Language** | Go binary | TypeScript middleware |
| **Deployment** | Standalone reverse proxy | Embeds in your existing app |
| **Lightning node** | Requires LND | Phoenixd, LND, CLN, LNbits, or none (Cashu-only) |
| **Serverless** | No — long-running process | Yes — Web Standard adapter runs on Cloudflare Workers, Deno, Bun |
| **Configuration** | YAML file | Programmatic (code) |

## Production checklist

- Set a persistent `rootKey` (64 hex chars / 32 bytes), otherwise tokens are invalidated on restart.
- Use a persistent `dbPath` (default: `./toll-booth.db`).
- Enable `strictPricing: true` to prevent unpriced routes from bypassing billing.
- Ensure your `pricing` keys match the paths the middleware actually sees (after mounting).
- Set `trustProxy: true` when behind a reverse proxy, or provide a `getClientIp` callback for per-client free-tier isolation.
- If you implement `redeemCashu`, make it idempotent for the same `paymentHash` — crash recovery depends on it.
- Rate-limit `/create-invoice` at your reverse proxy — each call creates a real Lightning invoice.

## Example deployment

See [`examples/valhalla-proxy/`](examples/valhalla-proxy/) for a complete Docker Compose setup gating a [Valhalla](https://github.com/valhalla/valhalla) routing engine behind Lightning payments.

## Support

If you find toll-booth useful, consider sending a tip:

- **Lightning:** `thedonkey@strike.me`
- **Nostr zaps:** `npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`

## Licence

[MIT](LICENSE)
