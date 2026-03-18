# sats-for-laughs

A joke API gated by Lightning payments, powered by [toll-booth](https://github.com/forgesworn/toll-booth).

Pay 21 sats, get a joke. No account. No sign-up. This is the same code that runs the [live demo](https://jokes.trotters.dev/).

**Web UI:** Visit `http://localhost:3000/` in a browser for the human-friendly experience - get a joke, hit the paywall, scan the QR code or pay with a browser wallet extension.

**API:** `curl http://localhost:3000/api/joke` for programmatic access.

## Three steps to a paid API

### 1. Try it locally (no Lightning node needed)

```bash
npm install
MOCK=true npm start
```

Mock mode auto-settles invoices so you can test the full L402 flow without real payments.

### 2. Deploy with Docker Compose

```bash
cp .env.example .env    # set PHOENIXD_PASSWORD and ROOT_KEY
docker compose up -d
```

This starts Phoenixd (Lightning node) and sats-for-laughs together. Your API is live and earning sats.

### 3. Make it yours

Replace the joke endpoint with your own API. The key lines in `server.ts`:

```typescript
const booth = new Booth({
  adapter: 'express',
  backend: phoenixdBackend({ url: '...', password: '...' }),
  pricing: { '/api/joke': 21 },           // your routes and prices
  upstream: `http://localhost:${UPSTREAM_PORT}`,  // your API
  freeTier: { requestsPerDay: 1 },
})
```

Change `pricing` to your routes, point `upstream` at your service, deploy.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/joke` | GET | Random joke (1 free/day, then 21 sats) |
| `/api/joke?topic=nostr` | GET | Joke on a specific topic |
| `/create-invoice` | POST | Get a Lightning invoice |
| `/invoice-status/:paymentHash` | GET | Check payment status (JSON or HTML payment page) |

Topics: bitcoin, lightning, nostr, freedom tech, meshtastic, handshake

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MOCK` | No | Set to `true` for local dev (auto-settles invoices) |
| `PHOENIXD_URL` | Production | Phoenixd HTTP endpoint |
| `PHOENIXD_PASSWORD` | Production | Phoenixd auth password |
| `ROOT_KEY` | Production | 64 hex chars for macaroon signing (persists tokens across restarts) |
| `PORT` | No | HTTP port (default: 3000) |

## Regenerating jokes

Requires an OpenAI API key:

```bash
OPENAI_API_KEY=sk-... npm run generate-jokes
```
