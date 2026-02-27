# lightning-gate

[![MIT licence](https://img.shields.io/badge/licence-MIT-blue.svg)](./package.json)

Generic L402 middleware for gating any HTTP API behind Lightning Network payments. Drop it into a Hono app and your API becomes a paywall in minutes.

## Quick start

```ts
import { Hono } from 'hono'
import { lightningGate } from 'lightning-gate'
import { phoenixdBackend } from 'lightning-gate/backends/phoenixd'

const app = new Hono()

const gate = lightningGate({
  backend: phoenixdBackend({ url: 'http://localhost:9740', password: 'your-password' }),
  pricing: {
    '/route': 2,
    '/isochrone': 5,
    '/sources_to_targets': 10,
  },
  freeTier: { requestsPerDay: 10 },
  upstream: 'http://localhost:8002',
})

app.use('/api/*', gate)
```

## Payment flow

1. Client requests an endpoint without credentials — free tier is checked.
2. Free tier exhausted → **402 response** containing a Lightning invoice and a macaroon.
3. Client pays the invoice and receives a preimage from their wallet.
4. Client sends `Authorization: L402 <macaroon>:<preimage>` on subsequent requests.
5. Each authenticated request deducts from the credit balance encoded in the macaroon.
6. Credits exhausted → new 402 with a fresh invoice.

## Free tier

Each IP address gets a configurable number of free requests per day — no signup required. Once the free allowance is consumed, the client must pay to continue.

## Backends

| Backend    | Status      |
|------------|-------------|
| Phoenixd   | Implemented |
| LND        | Coming soon |
| Alby       | Coming soon |

## Reference deployment

See [`examples/valhalla-proxy/`](./examples/valhalla-proxy/) for a complete Docker Compose setup that gates a [Valhalla](https://github.com/valhalla/valhalla) routing engine behind lightning-gate.

## Protocol

lightning-gate implements the [L402 protocol](https://docs.lightning.engineering/the-lightning-network/l402) — HTTP 402 Payment Required combined with the Lightning Network for machine-payable APIs.
