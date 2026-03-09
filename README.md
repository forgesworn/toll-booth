# toll-booth

[![MIT licence](https://img.shields.io/badge/licence-MIT-blue.svg)](./package.json)
[![Nostr](https://img.shields.io/badge/Nostr-Zap%20me-purple)](https://primal.net/p/npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2)

Embeddable [L402](https://docs.lightning.engineering/the-lightning-network/l402) middleware for JavaScript. Gate any HTTP API behind Lightning payments — no separate proxy, no LND required.

```ts
import { Hono } from 'hono'
import { tollBooth } from 'toll-booth'
import { phoenixdBackend } from 'toll-booth/backends/phoenixd'

const app = new Hono()

const booth = tollBooth({
  backend: phoenixdBackend({ url: 'http://localhost:9740', password: 'your-password' }),
  pricing: {
    '/route': 2,
    '/isochrone': 5,
    '/sources_to_targets': 10,
  },
  freeTier: { requestsPerDay: 10 },
  upstream: 'http://localhost:8002',
  rootKey: process.env.ROOT_KEY, // 32-byte hex key
  dbPath: './toll-booth.db',
  trustProxy: true, // only behind a trusted reverse proxy that sets client IP headers
  adminToken: process.env.ADMIN_TOKEN, // protects /stats and /admin/reset-free-tier
})

app.use('/api/*', booth)
```

## Why not Aperture?

[Aperture](https://github.com/lightninglabs/aperture) is Lightning Labs' production L402 reverse proxy. It's battle-tested and feature-rich. Use it if you can.

toll-booth exists for the cases where Aperture doesn't fit:

| | Aperture | toll-booth |
|---|---|---|
| **Language** | Go binary | TypeScript middleware |
| **Deployment** | Standalone reverse proxy | Embeds in your existing app |
| **Lightning node** | Requires LND | Phoenixd (lighter), LND coming soon |
| **Serverless** | No — long-running process | Yes — runs on Cloudflare Workers, Deno, Bun |
| **Configuration** | YAML file | Programmatic (code) |
| **Maturity** | Production (powers Lightning Loop) | Alpha |

**Use Aperture** if you run LND and want a proven, standalone proxy with TLS, Tor, Prometheus, and dynamic pricing.

**Use toll-booth** if you want L402 as middleware in a JS app, need Phoenixd support, or deploy to serverless/edge runtimes where a Go binary isn't an option.

## Payment flow

1. Client requests an endpoint without credentials — free tier is checked.
2. Free tier exhausted → **402 response** containing a Lightning invoice and a macaroon.
3. Client pays the invoice and receives a preimage from their wallet.
4. Client sends `Authorization: L402 <macaroon>:<preimage>` on subsequent requests.
5. Each authenticated request deducts from the credit balance encoded in the macaroon.
6. Credits exhausted → new 402 with a fresh invoice.

## Free tier

Each IP address gets a configurable number of free requests per day — no signup required. Once the free allowance is consumed, the client must pay to continue.

`X-Forwarded-For` is only used when `trustProxy: true`. Keep this disabled unless you run behind a trusted reverse proxy that overwrites client IP headers.

## Production checklist

- Set a persistent `rootKey` (32-byte hex), otherwise tokens are invalidated on restart.
- Use a persistent `dbPath` (default: `./toll-booth.db`).
- Upgrade/patch dependencies regularly (`npm audit`).
- If you expose `/stats` or `/admin/reset-free-tier`, set `adminToken` (or use `trustProxy: true` with strict loopback-only proxy rules).

## Backends

| Backend    | Status      |
|------------|-------------|
| Phoenixd   | Implemented |
| LND        | Coming soon |
| Alby       | Coming soon |

## Reference deployment

See [`examples/valhalla-proxy/`](./examples/valhalla-proxy/) for a complete Docker Compose setup that gates a [Valhalla](https://github.com/valhalla/valhalla) routing engine behind toll-booth.

## Support

If you find toll-booth useful, consider sending a tip:

- **Lightning:** `thedonkey@strike.me`
- **Nostr zaps:** `npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`
