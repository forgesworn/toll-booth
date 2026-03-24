# Monetise any Express API in 60 Seconds

## What you'll build

An Express API that charges 10 sats per request via Lightning. Free tier included - your first users get 5 requests per day before they need to pay.

## Prerequisites

- Node.js 18+
- A Lightning backend ([Phoenixd](https://phoenix.acinq.co/server) recommended), or skip it and use a mock for testing

## Install

```bash
npm install express @forgesworn/toll-booth
```

## Code

Create `server.ts`:

```typescript
import express from 'express'
import { Booth } from '@forgesworn/toll-booth'
import { phoenixdBackend } from '@forgesworn/toll-booth/backends/phoenixd'

const backend = phoenixdBackend({
  url: process.env.PHOENIXD_URL ?? 'http://localhost:9740',
  password: process.env.PHOENIXD_PASSWORD ?? '',
})

const app = express()
app.use(express.json())

const booth = new Booth({
  adapter: 'express',
  backend,
  pricing: { '/api': 10 },
  upstream: process.env.UPSTREAM_URL ?? 'http://localhost:4000',
  freeTier: { requestsPerDay: 5 },
  defaultInvoiceAmount: 100,
  rootKey: process.env.ROOT_KEY,
})

app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as any)
app.post('/create-invoice', booth.createInvoiceHandler as any)
app.use('/', booth.middleware as any)

app.listen(3000, () => console.log('Paid API on :3000'))
```

That's it. Every request to `/api/*` costs 10 sats. Unrecognised routes fall back to `defaultInvoiceAmount` (100 sats).

Set `ROOT_KEY` to a 64-character hex string in production (32 random bytes). Without it, toll-booth generates a random key on startup and all macaroons are lost on restart.

```bash
export ROOT_KEY=$(openssl rand -hex 32)
```

## Test it

**1. Free tier** - first 5 requests per day go through:

```bash
curl http://localhost:3000/api/resource
# 200 OK - served from free tier
```

**2. Exhaust free tier, get a 402 challenge:**

```bash
curl -i http://localhost:3000/api/resource
# 402 Payment Required
# WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
```

**3. Create an invoice** (optionally with a specific amount):

```bash
curl -X POST http://localhost:3000/create-invoice
# { "paymentHash": "abc...", "bolt11": "lnbc...", "macaroon": "..." }
```

**4. Pay the invoice** with any Lightning wallet, then use the preimage:

```bash
curl -H "Authorization: L402 <macaroon>:<preimage>" \
  http://localhost:3000/api/resource
# 200 OK - credit deducted, X-Credit-Balance header shows remaining
```

## Without a Lightning node

For local development, use a mock backend that auto-settles invoices. See [`examples/sats-for-laughs/server.ts`](../../examples/sats-for-laughs/server.ts) for a working mock pattern, or run with `MOCK=true` if using that example directly.

## What's next

- **[Credit tiers](../configuration.md)** - volume discounts (pay 10k sats, get 11.1k credits)
- **[Cashu payments](../configuration.md)** - accept ecash tokens alongside Lightning
- **[x402 stablecoins](../configuration.md)** - accept USD stablecoin payments via Base
- **[IETF Payment](../configuration.md)** - standards-track `WWW-Authenticate: Payment` challenges
- **Hono quickstart** - use `createHonoTollBooth()` for idiomatic Hono integration (see [configuration](../configuration.md))
- **[Full documentation](../configuration.md)** - all options, backends, and deployment patterns
