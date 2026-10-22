# sats-for-laughs

A joke API gated by Lightning payments, powered by [toll-booth](https://github.com/forgesworn/toll-booth).

Pay 21 sats, get a joke. No account. No sign-up. Run it yourself with mock Lightning or a real backend. The hosted demo that ran this code was retired on 22 October 2026.

**Web UI:** visit `http://localhost:3000/` in a browser for the human-friendly experience - get a joke, hit the paywall, scan the QR code or pay with a browser wallet extension.

**API:** `curl http://localhost:3000/api/joke` for programmatic access.

## Run your own

### 1. Try it locally (no Lightning node needed)

The example links the local toll-booth package, so build that first, from the repository root:

```bash
npm install && npm run build
cd examples/sats-for-laughs
npm install
MOCK=true npm start
```

Mock mode auto-settles invoices about a second after they are created, so you can test the full L402 flow without real payments. `.env` is read by Docker Compose only; for `npm start`, set variables in the shell as above.

### 2. Deploy with Docker Compose

Phoenixd creates its own passwords on first start, so bring it up first:

```bash
cp .env.example .env
docker compose up -d phoenixd
docker compose exec phoenixd grep http-password /root/.phoenix/phoenix.conf
```

Edit `.env`:

- `ROOT_KEY`: the output of `openssl rand -hex 32`. An empty value is rejected.
- `PHOENIXD_PASSWORD`: the `http-password-limited-access` value printed above. It can create and look up invoices but cannot spend.
- `PHOENIXD_URL`: `http://phoenixd:9740`. The `localhost` value in `.env.example` points at the app container itself, not at Phoenixd.
- `PUBLIC_URL` and `ANNOUNCE_RELAYS`: clear both, or set your own. The values in `.env.example` are placeholders, and while both are set the server publishes a Nostr announcement for that URL at startup.

Then start everything:

```bash
docker compose up -d
```

This starts Phoenixd (Lightning node) and sats-for-laughs together on port 3000, with the invoice database in the `app-data` volume. Phoenixd's wallet lives in the `phoenixd-data` volume, so back up its seed before relying on it.

To use a wallet you already run instead of Phoenixd, put a `nostr+walletconnect://` URI in a file, mount it into the app container (for example `./nwc-uri:/run/nwc-uri:ro` under `volumes`, readable by the container's `app` user) and set `NWC_URI_FILE=/run/nwc-uri` in `.env`. Restrict the connection to `make_invoice` and `lookup_invoice` so this server can take payments but cannot spend what it collects. Start only the app with `docker compose up -d --no-deps sats-for-laughs`.

### 3. Make it yours

Replace the joke endpoint with your own API. The key lines in `server.ts`:

```typescript
const booth = new Booth({
  adapter: 'express',
  backend,                                        // mock, NWC or Phoenixd, chosen from the environment
  pricing: { '/api/joke': { default: 5, standard: 21, premium: 42 } },  // your routes and prices
  upstream: `http://localhost:${UPSTREAM_PORT}`,  // your API
  freeTier: { requestsPerDay: 3 },
})
```

Change `pricing` to your routes, point `upstream` at your service, deploy. `server.ts` also sets `creditTiers` (the bundles offered on the payment page) and Nostr announcement metadata.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/joke` | GET | Random joke (3 free/day, then 5, 21 or 42 sats by quality tier) |
| `/api/joke?topic=nostr` | GET | Joke on a specific topic |
| `/create-invoice` | POST | Get a Lightning invoice (21 sats by default) |
| `/invoice-status/:paymentHash?token=...` | GET | Check payment status (JSON or HTML payment page). Use the `payment_url` from the invoice response, which carries the token |

Topics: bitcoin, lightning, nostr, freedom tech, meshtastic, handshake

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MOCK` | No | Set to `true` for local dev (auto-settles invoices, in-memory storage) |
| `PHOENIXD_URL` | With Phoenixd | Phoenixd HTTP endpoint (default `http://localhost:9740`; `http://phoenixd:9740` under Docker Compose) |
| `PHOENIXD_PASSWORD` | With Phoenixd | Phoenixd auth password |
| `NWC_URI_FILE` | No | Path to a file holding a `nostr+walletconnect://` URI; used instead of Phoenixd when set |
| `ROOT_KEY` | Production | 64 hex chars for macaroon signing (persists tokens across restarts). If unset, a random key is generated at startup; an empty or invalid value stops the server |
| `PORT` | No | HTTP port (default: 3000) |
| `TOLL_BOOTH_DB_PATH` | No | SQLite path outside mock mode (default: `/data/toll-booth.db`) |
| `DATA_DIR` | No | Where the announcement key is saved (default `~/.sats-for-laughs`) and where an optional `attestation-event-id` file is read from (`/data` if unset) |
| `PUBLIC_URL` | No | Public URL of your deployment; with `ANNOUNCE_RELAYS`, enables the Nostr announcement |
| `ANNOUNCE_RELAYS` | No | Comma-separated relay URLs for the announcement |
| `ANNOUNCE_KEY` | No | Hex secret key for the announcement (generated and saved under `DATA_DIR` if unset) |

### Release deployment

[`deploy/production-jokes.sh`](../../deploy/production-jokes.sh) is the
script the hosted demo was deployed with. It accepts only an exact release tag
via `DEPLOY_REF`, builds that tag in an isolated Git worktree, reads the
Phoenixd credential from the running node without a fallback, and rolls back
the container if the health check fails. You do not need it to run your own.

The server-local `/opt/sats-for-laughs/deploy.conf` contains non-secret runtime
identity only:

```dotenv
PUBLIC_URL=https://service.example.com
ANNOUNCE_RELAYS=wss://relay.example.com,wss://relay2.example.com
```

The macaroon root key remains in a mode-0600 server-local file. Never put it or
the Phoenixd password in `deploy.conf`, a workflow, or a command argument.

## Regenerating jokes

Requires an OpenAI API key:

```bash
OPENAI_API_KEY=sk-... npm run generate-jokes
```
