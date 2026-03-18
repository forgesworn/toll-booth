# X Article -toll-booth launch

## Title

**HTTP 402: The Web's Lost Payment Status Code - and the Middleware That Finally Uses It**

## Image prompt (5:2)

A wide cinematic scene of a futuristic toll booth on an elevated highway at night. The booth glows with amber and electric blue neon light. Instead of cars, streams of glowing data packets and small lightning bolts flow through the booth lanes. The background is a dark cityscape with faint circuit-board patterns in the sky. Minimal, clean, slightly cyberpunk. No text or logos. Photorealistic digital art, dramatic lighting, 5:2 aspect ratio.

---

## Article

In 1999, the architects of the web reserved HTTP status code 402 -Payment Required. It was a placeholder for a future where the internet had native payments. Twenty-five years later, we still don't use it.

Every API on the web assumes you're a human with a credit card. Sign up. Get a key. Add a billing method. Wait for approval. This works fine when the consumer is a developer at a desk. It falls apart completely when the consumer is an autonomous AI agent that needs to call your API at 3am.

AI agents can't fill in registration forms. Autonomous services can't wait 30 days for a NET-30 invoice. The machine-to-machine economy needs a protocol where the server states a price, the client pays, and the request proceeds. No accounts. No API keys. No middlemen.

**The payment is the authentication.**

That's exactly what L402 does -and I've built the middleware to make it trivial.

### Introducing toll-booth

toll-booth is open-source TypeScript middleware that gates any HTTP API behind Lightning payments. One function call turns your API into a pay-per-request service.

```typescript
import { Booth } from 'toll-booth'
import { phoenixdBackend } from 'toll-booth/backends/phoenixd'

const booth = new Booth({
  adapter: 'express',
  backend: phoenixdBackend({
    url: 'http://localhost:9740',
    password: process.env.PHOENIXD_PASSWORD,
  }),
  pricing: { '/api': 10 },           // 10 sats per request
  upstream: 'http://localhost:8080',  // your existing API
})
```

The flow is beautifully simple:

1. Client hits a priced endpoint without credentials
2. Server responds with HTTP 402, a BOLT-11 invoice, and a macaroon
3. Client pays the invoice and gets a preimage
4. Client resends the request with `Authorization: L402 <macaroon>:<preimage>`
5. Server verifies, deducts credit, proxies the request upstream

The web working like a vending machine. See the price. Pay. Get the thing.

### Five Lightning backends, zero lock-in

toll-booth doesn't care what Lightning node you run. Phoenixd, LND, Core Lightning, LNbits, or any NWC-compatible wallet — pick the one you already have.

Each backend implements a two-method interface: create an invoice, check if it's paid. That's it. Swapping backends is a one-line change.

### Cashu: no Lightning node required

This is the part that changes everything.

Cashu ecash tokens let clients pay without any Lightning infrastructure on the server side. A Cloudflare Worker -a serverless function with no persistent process -can gate an API behind real payments. No node. No channels. No liquidity management.

Serverless micropayments. For real.

### NWC: wallet-native payments over Nostr

Nostr Wallet Connect adds a third payment rail. Clients pay from any NWC-compatible wallet using the same relay infrastructure they already use for social. The server doesn't need to know or care which method the client chooses -Lightning, Cashu, or NWC all settle the same way.

Three payment rails. One middleware. The client picks.

### Not vapourware

toll-booth is running in production right now. It gates a Valhalla routing engine at routing.trotters.cc -real Lightning invoices, real payments, real map queries returned.

It includes a free tier for discovery (configurable daily allowance per IP), volume discount tiers for committed users, and a self-service payment page with QR codes and wallet adapter buttons.

### The bigger picture

We're entering an era where AI agents will consume more API calls than humans. The current model -where every API requires a human to register and manage credentials -doesn't scale to a world of autonomous software.

L402 gives machines a way to pay for what they use, instantly, without permission from anyone. HTTP 402 was waiting for this moment. The infrastructure is finally here.

### Get started

```bash
npm install @forgesworn/toll-booth
```

Express, Deno, Bun, and Cloudflare Workers. MIT licence.

**GitHub:** github.com/forgesworn/toll-booth

If you find it useful, zap me: thedonkey@strike.me
