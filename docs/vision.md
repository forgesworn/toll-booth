# The Vending Machine Web

The web's payment layer assumes you're human.

Sign up. Verify your email. Add a credit card. Generate an API key. Rotate it quarterly. Pay an invoice in 30 days. Every API on the internet gates access through identity — and identity means accounts, credentials, and trust relationships that only humans can establish.

Machines can't fill in forms. AI agents can't produce a passport. Autonomous services can't wait 30 days for an invoice to clear.

The HTTP specification reserved status code 402 — Payment Required — in 1999. It took a quarter century for the payment rails to catch up.

## The protocol

**L402** combines three primitives:

1. **HTTP 402** — the server demands payment before granting access
2. **A Lightning invoice** (or Cashu ecash token) — the client pays instantly, with finality, no intermediary
3. **A macaroon credential** — cryptographic proof of payment that the client presents on subsequent requests

No accounts. No API keys. No OAuth dance. No PII exchanged. The client pays; the server verifies; the request proceeds. The entire interaction is stateless, pseudonymous, and settles in seconds.

## Payment pluralism

A single protocol. Multiple rails. The client picks how to pay.

**Lightning** — the interoperability backbone. toll-booth speaks to five backends: Phoenixd (simplest self-hosted option), LND (industry standard), Core Lightning, LNbits (any instance — self-hosted or hosted), and NWC (any Nostr Wallet Connect wallet — Alby Hub, Mutiny, Umbrel, Phoenix, and more). Use what you already run. No vendor lock-in.

**Cashu** — ecash tokens. No Lightning node required. No channel liquidity. No routing failures. Mint tokens from any Cashu mint, redeem them at the toll booth, receive access. This is the edge computing play: a Cloudflare Worker can gate an API behind Cashu payments without a single piece of Lightning infrastructure. Instant, offline-capable, privacy-preserving.

**Nostr Wallet Connect** — wallet-to-wallet payments over Nostr relays. The client's wallet pays the invoice directly, no browser extension required. Any NWC-compatible wallet works. The payment travels the same relay infrastructure the client already uses for social communication.

**x402 / stablecoins** — on the roadmap. Coinbase's x402 protocol brings USDC and other stablecoins to the HTTP 402 flow. When toll-booth adds x402 as a backend, a single deployment will accept Lightning, Cashu, NWC, and stablecoin payments simultaneously. Same middleware, same credit accounting, one more rail.

Four rails and counting. One middleware. The API operator picks which to accept. The client picks which to use. Neither needs permission from the other.

## The vending machine web

Picture a web of autonomous services. A routing engine that charges 2 sats per query. A weather API that accepts ecash tokens. An AI inference endpoint that settles via NWC. A mapping service that offers volume discounts for pre-paid credit.

No sign-up pages. No billing dashboards. No subscription tiers designed by a growth team. Just services with prices, clients with wallets, and a protocol that connects them.

An AI agent discovers a service, reads its price from the 402 response, pays the invoice from its Cashu wallet, and accesses the data — all in a single HTTP round-trip. No human in the loop. No OAuth token to refresh. No API key to leak.

This is not a theoretical future. toll-booth is deployed in production at [routing.trotters.cc](https://routing.trotters.cc), gating a Valhalla routing engine behind Lightning payments. Real invoices, real payments, real map queries.

## What toll-booth is

One npm install. Ten lines of code. Any JavaScript runtime — Node.js, Deno, Bun, Cloudflare Workers.

toll-booth is middleware that turns any HTTP API into a vending machine. It handles the L402 challenge-response flow, invoice creation, payment verification, credit accounting, and upstream proxying. You bring the API. You bring the payment backend (or don't — Cashu-only mode needs no Lightning node at all). toll-booth handles the rest.

The protocol is the contract. The payment is the authentication. The web becomes a marketplace.

```
npm install @forgesworn/toll-booth
```
