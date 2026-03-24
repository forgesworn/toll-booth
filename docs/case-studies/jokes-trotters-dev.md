# jokes.trotters.dev: From Zero to Production L402 API

## Problem

You want to deploy a paid API to production. What does a real deployment look like? How much code is needed? What infrastructure do you need?

Most payment integration tutorials stop at "here's how to call the SDK". They rarely show the full picture - Docker, Lightning node, persistence, tiered pricing, free trials, and a self-service payment page that works in a browser. jokes.trotters.dev is a complete, running example of all of that.

## Solution

[jokes.trotters.dev](https://jokes.trotters.dev) is a joke API that charges satoshis per joke via Lightning. It runs on a VPS with Docker Compose, using Phoenixd as the Lightning backend. The entire deployment is the `sats-for-laughs` example from toll-booth.

Three quality tiers are available:

| Tier | Price | What you get |
|------|-------|--------------|
| Cracker | 5 sats | Bad puns and groaners |
| Standard | 21 sats | Solid jokes across 6 topics |
| Premium | 42 sats | Top-shelf comedy |

Every IP address gets 3 free jokes per day before hitting the paywall. Volume discounts reward bulk buyers; 100 sats gets you 105 credits, and 210 sats gets you 252 credits worth of premium jokes.

## Architecture

The production stack is two Docker containers on a Hetzner VPS:

```
┌─────────────────────────────────────────────┐
│  Docker Compose                             │
│                                             │
│  ┌───────────────────┐  ┌───────────────┐  │
│  │  sats-for-laughs  │  │   Phoenixd    │  │
│  │  (Express + TB)   │──│  (Lightning)  │  │
│  │  port 3000        │  │  port 9740    │  │
│  └───────────────────┘  └───────────────┘  │
│         │                                   │
│    ┌────┴────┐                              │
│    │ SQLite  │                              │
│    │  (WAL)  │                              │
│    └─────────┘                              │
└─────────────────────────────────────────────┘
```

- **Phoenixd** - ACINQ's lightweight Lightning node; no channel management, no LND, no CLN. It handles invoices and receives payments automatically.
- **toll-booth with Express adapter** - the `Booth` class wires together the payment engine, storage, and HTTP middleware in a single constructor call.
- **SQLite in WAL mode** - persists credit balances, invoices, and Cashu claim records across restarts.
- **402-announce** - on startup, the server publishes a Nostr kind 31402 event so that AI agents and service directories can discover it automatically.

## What the deployment includes

The application code lives in four files:

- **`server.ts`** (~130 lines of application logic) - Express setup, joke selection, toll-booth configuration with tiered pricing, volume discounts, and Nostr announcement.
- **`docker-compose.yml`** (25 lines) - two services (sats-for-laughs + Phoenixd), two volumes.
- **`Dockerfile`** (26 lines) - multi-stage build that packs toll-booth from source.
- **`public/index.html`** - self-service payment page with QR codes, tier selector, and wallet adapter buttons.

The toll-booth configuration itself is roughly 35 lines; five credit tiers, a pricing map, free tier settings, and event callbacks for logging.

## Try it

```bash
# Get a free joke (3 per day per IP)
curl https://jokes.trotters.dev/api/joke

# After free tier is exhausted, get an invoice
curl -X POST https://jokes.trotters.dev/create-invoice

# Pay the Lightning invoice, then authenticate with the preimage
curl -H "Authorization: L402 <macaroon>:<preimage>" \
  https://jokes.trotters.dev/api/joke
```

Or visit [https://jokes.trotters.dev](https://jokes.trotters.dev) in a browser for the self-service payment page with QR codes and wallet integration.

## Key takeaway

A production L402 API with tiered pricing, volume discounts, a free tier, Nostr discoverability, and a self-service payment page requires roughly 130 lines of application code plus a 25-line Docker Compose file. The infrastructure cost is a small VPS and a Phoenixd node; no LND, no channel management, no payment processor accounts.

## Links

- **Live:** [https://jokes.trotters.dev](https://jokes.trotters.dev)
- **Source:** [`examples/sats-for-laughs`](../../examples/sats-for-laughs/)
- **toll-booth:** [https://github.com/forgesworn/toll-booth](https://github.com/forgesworn/toll-booth)
