# Monetise your Ollama Endpoint in 60 Seconds

Turn your local Ollama instance into a Lightning-paid API. Every inference request costs a few sats; no account system, no API keys, no billing dashboard.

## What you'll build

A reverse proxy that sits between clients and your Ollama server. Unauthenticated requests get a 402 response with a Lightning invoice. Once paid, the client includes an L402 token and requests are proxied through to Ollama.

```
Client ---> toll-booth (port 3000) ---> Ollama (port 11434)
              |
              +-- 402 + invoice (unpaid)
              +-- proxy through (paid / free tier)
```

## Prerequisites

- **Node.js 18+**
- **Ollama** running locally on `http://localhost:11434` (`ollama serve`)
- A **Lightning backend** - any of: Phoenixd, LND, CLN, LNbits, or NWC

No Lightning node yet? Use the mock backend below to test the full flow without real payments.

## Install

```bash
mkdir ollama-paid && cd ollama-paid
npm init -y
npm install express @forgesworn/toll-booth
```

## The server

Create `server.mjs`:

```js
import express from 'express'
import { Booth } from '@forgesworn/toll-booth'
import { phoenixdBackend } from '@forgesworn/toll-booth/backends/phoenixd'

const backend = phoenixdBackend({
  url: process.env.PHOENIXD_URL || 'http://localhost:9740',
  password: process.env.PHOENIXD_PASSWORD || '',
})

const booth = new Booth({
  adapter: 'express',
  backend,
  upstream: 'http://localhost:11434',
  pricing: {
    '/api/generate': 50,
    '/api/chat': 100,
    '/api/embeddings': 10,
  },
  freeTier: { requestsPerDay: 5 },
  defaultInvoiceAmount: 100,
  rootKey: process.env.ROOT_KEY,
})

const app = express()
app.use(express.json({ limit: '1mb' }))
app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler)
app.post('/create-invoice', booth.createInvoiceHandler)
app.use('/', booth.middleware)

app.listen(3000, () => console.log('Ollama paywall on :3000'))
```

That's it - 25 lines. Every request to `/api/generate` costs 50 sats, `/api/chat` costs 100 sats, and `/api/embeddings` costs 10 sats. The first 5 requests per day per IP are free.

## Using a different backend

Swap `phoenixdBackend` for whichever node you run:

```js
// LND
import { lndBackend } from '@forgesworn/toll-booth/backends/lnd'
const backend = lndBackend({
  url: process.env.LND_REST_URL,
  macaroon: process.env.LND_MACAROON,
})

// Core Lightning
import { clnBackend } from '@forgesworn/toll-booth/backends/cln'
const backend = clnBackend({
  url: process.env.CLN_REST_URL,
  rune: process.env.CLN_RUNE,
})

// LNbits
import { lnbitsBackend } from '@forgesworn/toll-booth/backends/lnbits'
const backend = lnbitsBackend({
  url: process.env.LNBITS_URL,
  apiKey: process.env.LNBITS_API_KEY,
})
```

## Test without a Lightning node

For local development, skip the real backend entirely and use in-memory storage with a mock that auto-settles invoices:

```js
import crypto from 'node:crypto'
import { Booth, memoryStorage } from '@forgesworn/toll-booth'

const storage = memoryStorage()

const mockBackend = {
  async createInvoice(amountSats, memo) {
    const preimage = crypto.randomBytes(32)
    const paymentHash = crypto.createHash('sha256').update(preimage).digest('hex')
    const bolt11 = `lnbc${amountSats}n1mock${crypto.randomBytes(16).toString('hex')}`
    // Auto-settle after 1 second (simulates instant payment)
    setTimeout(() => storage.settleWithCredit(paymentHash, amountSats, preimage.toString('hex')), 1000)
    return { bolt11, paymentHash }
  },
  async checkInvoice(paymentHash) {
    return { paid: storage.isSettled(paymentHash), preimage: storage.getSettlementSecret(paymentHash) }
  },
}

const booth = new Booth({
  adapter: 'express',
  backend: mockBackend,
  storage,
  upstream: 'http://localhost:11434',
  pricing: { '/api/generate': 50, '/api/chat': 100 },
  freeTier: { requestsPerDay: 5 },
})
```

## Test it

Start Ollama and the proxy:

```bash
ollama serve &
node server.mjs
```

**First request (free tier):**

```bash
curl http://localhost:3000/api/generate \
  -d '{"model":"llama3.2","prompt":"Say hello in one sentence"}'
```

You'll get a normal Ollama response. After 5 free requests, you'll see the L402 challenge:

**Sixth request (402 challenge):**

```bash
curl -i http://localhost:3000/api/generate \
  -d '{"model":"llama3.2","prompt":"Why is the sky blue?"}'
```

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: L402 macaroon="...", invoice="lnbc500n1..."
```

The response includes a BOLT-11 Lightning invoice. Pay it with any Lightning wallet, then use the macaroon and preimage to authenticate:

```bash
curl http://localhost:3000/api/generate \
  -H 'Authorization: L402 <macaroon>:<preimage>' \
  -d '{"model":"llama3.2","prompt":"Why is the sky blue?"}'
```

The `X-Credit-Balance` response header shows remaining sats.

## For production

This flat-rate approach works for simple cases, but AI inference varies wildly per request. A short completion might use 50 tokens; a long one might use 4,000. For production deployments, look at [**satgate**](https://github.com/TheCryptoDonkey/satgate) - a production-grade inference gateway built on toll-booth (~400 lines) that adds:

- **Per-token metering** - charges based on actual token usage, not flat rates
- **Streaming reconciliation** - counts tokens in real-time SSE streams
- **Model-specific pricing** - charge more for larger models (70B vs 7B)
- **Cost transparency** - `X-Tokens-Used` and `X-Cost-Sats` response headers

## What's next

Once the basic paywall is running, toll-booth supports several upgrades:

- **Credit tiers** for volume discounts - let heavy users buy in bulk at a lower per-request rate. See `creditTiers` in the [API docs](../../README.md).
- **Cashu ecash** for privacy-preserving payments - clients pay with bearer tokens instead of Lightning invoices. No sender identity leaked.
- **x402 stablecoin rail** - accept USDC payments alongside Lightning for clients who prefer dollar-denominated pricing.
- **Nostr service announcements** - publish your API on Nostr relays so AI agents can discover and pay for it autonomously. See [toll-booth-announce](https://github.com/forgesworn/toll-booth-announce).
