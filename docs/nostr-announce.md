# Machines Will Pay Machines — and They Won't Ask Permission

*Published as a Nostr long-form note (kind 30023)*

---

Every API on the internet works the same way: sign up, get a key, make requests, get invoiced. The entire model assumes a human on the other end — someone who can read a terms-of-service page, type in a credit card number, and remember to rotate their credentials.

But what happens when the client isn't human?

I've been building [TROTT](https://github.com/TheCryptoDonkey/trott) — an open protocol for decentralised task coordination over Nostr. Drivers, couriers, service providers, and the AI agents that dispatch them. The protocol works. The coordination works. But every time an agent needs to call an external API — routing, geocoding, weather, inference — it hits the same wall: *please create an account*.

Machines can't create accounts. They shouldn't have to.

## HTTP 402: the door that's been locked since 1999

The HTTP spec has always had a status code for this: **402 Payment Required**. It was reserved in HTTP/1.1, left undefined, waiting for a payment layer that didn't exist yet.

Lightning made it real. The **L402 protocol** combines HTTP 402 with a Lightning invoice and a macaroon credential. The server says "pay this", the client pays, and the server verifies — all in a single request cycle. No accounts. No sessions. No PII. The payment *is* the authentication.

I needed this for TROTT. I looked at [Aperture](https://github.com/lightninglabs/aperture) — Lightning Labs' L402 reverse proxy. It's solid, battle-tested, and written in Go. But it requires LND specifically, runs as a standalone binary, and can't deploy to serverless environments. I needed something that embeds in a TypeScript API, works with whatever Lightning backend the operator runs, and deploys to Cloudflare Workers.

So I built **toll-booth**.

## One middleware, three payment rails

toll-booth is L402 middleware for any JavaScript runtime. But the part I'm most proud of isn't the L402 flow — it's the payment pluralism.

### Lightning — the interoperability layer

Five backends. Phoenixd if you want the simplest self-hosted setup. LND if that's what you run. Core Lightning via its REST API. LNbits if you want a lightweight instance. Alby via Nostr Wallet Connect if you want wallet-native integration.

You shouldn't have to switch Lightning implementations to use a payment middleware. Use what you already have.

```typescript
import { phoenixdBackend } from '@thecryptodonkey/toll-booth/backends/phoenixd'
import { lndBackend } from '@thecryptodonkey/toll-booth/backends/lnd'
import { clnBackend } from '@thecryptodonkey/toll-booth/backends/cln'
import { lnbitsBackend } from '@thecryptodonkey/toll-booth/backends/lnbits'
import { albyBackend } from '@thecryptodonkey/toll-booth/backends/alby'
```

### Cashu — the edge computing play

This is the one that changes things.

Cashu ecash tokens require no Lightning node. No channel liquidity. No routing. A client mints tokens from any Cashu mint, presents them to the toll booth, and receives access. Settlement is instant and offline-capable.

Why does this matter? Because it means a **Cloudflare Worker can gate an API behind payments without a single piece of Lightning infrastructure**. No node to maintain. No channels to manage. No liquidity to worry about. Just a mint URL and a redemption callback.

```typescript
const booth = new Booth({
  adapter: 'web-standard',
  // No backend needed — Cashu only
  redeemCashu: async (token, hash) => {
    // Verify and redeem the ecash token
    return amountRedeemed
  },
  pricing: { '/api': 5 },
})
```

For serverless deployments, for edge functions, for environments where running a Lightning node is impractical — Cashu-only mode makes L402 accessible everywhere.

### NWC — the wallet-native path

Nostr Wallet Connect lets the client pay from any NWC-compatible wallet. The payment travels over the same Nostr relay infrastructure the user already uses. No browser extension. No custodial intermediary. The wallet pays the invoice directly.

For Nostr-native applications — and TROTT is one — this is the natural payment rail. The coordination protocol and the payment protocol share the same transport layer.

## What it looks like in practice

Ten lines to gate any API:

```typescript
import { Booth } from '@thecryptodonkey/toll-booth'
import { phoenixdBackend } from '@thecryptodonkey/toll-booth/backends/phoenixd'

const booth = new Booth({
  adapter: 'express',
  backend: phoenixdBackend({ url: '...', password: '...' }),
  pricing: { '/route': 2, '/geocode': 1 },
  freeTier: { requestsPerDay: 10 },
  creditTiers: [
    { amountSats: 1000, creditSats: 1000, label: 'Starter' },
    { amountSats: 10000, creditSats: 11100, label: 'Pro' },
  ],
})
```

Free tier for discovery. Volume discounts for commitment. Three payment methods for flexibility. The API operator sets the prices; the protocol handles the rest.

This isn't theoretical. toll-booth is running in production at **routing.trotters.cc**, gating a [Valhalla](https://github.com/valhalla/valhalla) routing engine behind Lightning payments. Real invoices. Real payments. Real map queries serving the TROTT network.

## The vending machine web

I keep coming back to the same mental model: **the web as a vending machine**.

You walk up. You see the price. You insert coins. You get the thing. No membership card. No loyalty programme. No account manager. The transaction is the entire relationship.

Now replace "you" with an AI agent. Replace "coins" with satoshis or ecash tokens. Replace "walk up" with an HTTP request. The model holds — and it scales to millions of autonomous interactions per second.

This is the web L402 enables. Not a web of walled gardens and API key dashboards, but a web of services with prices and clients with wallets. Permissionless. Pseudonymous. Instant settlement.

toll-booth is my contribution to making that web a little easier to build.

---

`npm install @thecryptodonkey/toll-booth`

GitHub: https://github.com/TheCryptoDonkey/toll-booth

Lightning: thedonkey@strike.me
Nostr: npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2
