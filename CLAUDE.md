# CLAUDE.md — toll-booth

L402 middleware — gates any HTTP API behind Lightning payments. Supports Express, Web Standard (Deno, Bun, Cloudflare Workers), and Hono.

## Commands

```bash
npm run build       # tsc → dist/
npm test            # vitest run
npm run typecheck   # tsc --noEmit
```

## Structure

```
src/
  index.ts                  # Public API exports
  types.ts                  # LightningBackend, BoothConfig, Invoice, CreditTier, events
  types/
    macaroon.d.ts           # Ambient type declarations for untyped `macaroon` npm package
  booth.ts                  # Booth class: facade that wires engine + adapters + storage
  macaroon.ts               # Macaroon minting, verification, caveat parsing
  free-tier.ts              # Per-IP daily allowance tracking (in-memory)
  payment-page.ts           # Self-service HTML payment UI (QR, tier selector, wallet adapters)
  stats.ts                  # StatsCollector: in-memory usage analytics
  core/
    toll-booth.ts           # TollBoothEngine: framework-agnostic L402 payment flow
    create-invoice.ts       # POST /create-invoice handler (tier support)
    invoice-status.ts       # GET /invoice-status/:paymentHash handler
    nwc-pay.ts              # NWC (Nostr Wallet Connect) payment handler
    cashu-redeem.ts         # Cashu token redemption with lease/recovery logic
    types.ts                # Core request/result types (TollBoothRequest, NwcPayRequest, etc.)
  storage/
    interface.ts            # StorageBackend interface (credits, invoices, claims)
    sqlite.ts               # SQLite implementation (better-sqlite3, WAL mode)
    memory.ts               # In-memory implementation (tests, ephemeral use)
  adapters/
    express.ts              # Express 5 middleware + handlers
    web-standard.ts         # Web Standard (Request/Response) handlers (Deno, Bun, Workers)
    hono.ts                 # Hono middleware + payment route sub-app
    proxy-headers.ts        # X-Forwarded-For / X-Real-IP parsing
  backends/
    phoenixd.ts             # Phoenixd Lightning backend (HTTP API)
    lnd.ts                  # LND Lightning backend (REST API)
    cln.ts                  # Core Lightning backend (clnrest API)
    lnbits.ts               # LNbits Lightning backend (REST API)
    nwc.ts                  # Nostr Wallet Connect (NIP-47) backend
    conformance.ts          # Shared backend conformance test factory
  core/
    security.test.ts        # Security hardening tests (header injection, entropy, validation)
  e2e/
    l402-flow.integration.test.ts
    cashu-only.integration.test.ts
    cashu-redeem.integration.test.ts
    variable-metering-caveats.integration.test.ts

examples/
  valhalla-proxy/           # Complete Docker Compose reference deployment (Express)
```

## Testing

Unit tests are co-located with source files (`*.test.ts` next to `*.ts`). Integration tests live in `src/e2e/` and require running backends:

```bash
npm test                              # unit tests only (no env vars needed)
LND_REST_URL=... LND_MACAROON=... npm test -- src/backends/lnd.integration.test.ts
CLN_REST_URL=... CLN_RUNE=... npm test -- src/backends/cln.integration.test.ts
PHOENIXD_URL=... PHOENIXD_PASSWORD=... npm test -- src/backends/phoenixd.integration.test.ts
```

Backend conformance tests (`conformance.ts`) export a shared factory; each backend's integration test uses it.

## Architecture

**Payment flow:**
1. Client requests priced endpoint without L402 header
2. Free tier checked (per-IP, per-day allowance)
3. If exhausted → 402 response with BOLT-11 invoice + macaroon
4. Client pays (Lightning, NWC, or Cashu), obtains preimage or settlement secret
5. Client sends `Authorization: L402 <macaroon>:<preimage>`
6. Macaroon verified, credit granted, request proxied upstream with `X-Credit-Balance` header

**Booth class** is a facade that wires together the engine, storage, and adapter. Constructor takes `adapter: 'express' | 'web-standard' | 'hono'` to select framework integration. One `new Booth(config)` call exposes `.middleware`, `.invoiceStatusHandler`, `.createInvoiceHandler`, and optional `.nwcPayHandler` / `.cashuRedeemHandler`. For Hono, use `createHonoTollBooth()` directly for more idiomatic integration (auth middleware + payment route sub-app).

**Hono adapter** (`createHonoTollBooth()`) provides an auth middleware and a `createPaymentApp()` factory that returns a Hono sub-app with `/create-invoice`, `/invoice-status/:paymentHash`, and optional `/nwc-pay` and `/cashu-redeem` routes. Context variables (`TollBoothEnv`) expose payment state to downstream handlers.

**Core engine** (`createTollBooth()`) is framework-agnostic — adapters translate between framework requests and `TollBoothRequest`/`TollBoothResult`. Core handlers (`handleCreateInvoice`, `handleNwcPay`, `handleCashuRedeem`) follow the same pattern.

**Storage** is abstracted via `StorageBackend` interface. SQLite (WAL mode, better-sqlite3) is the default; `memoryStorage()` available for tests. Three tables: `credits` (balance ledger), `invoices`, `cashu_claims` (redemption leases).

**Backends:** Phoenixd, LND, CLN, LNbits, and NWC. All implement `LightningBackend` interface. Cashu-only mode works without any Lightning backend.

**Wallet adapters:** Optional NWC + Cashu payment methods (pluggable via `nwcPayInvoice` and `redeemCashu` callbacks). Cashu includes lease-based crash recovery.

**Volume discounts:** Credit tiers (e.g. pay 10k sats, get 11.1k credits).

**Invoice expiry:** Automatic hourly pruning of invoices older than `invoiceMaxAgeMs` (default 24h).

## Environment variables (valhalla-proxy example)

| Variable | Default | Description |
|----------|---------|-------------|
| `PHOENIXD_URL` | — | Phoenixd HTTP endpoint |
| `PHOENIXD_PASSWORD` | — | Phoenixd auth password |
| `VALHALLA_URL` | — | Upstream API to proxy |
| `FREE_TIER_REQUESTS` | 10 | Daily free requests per IP |
| `DEFAULT_INVOICE_SATS` | 1000 | Default invoice amount |
| `TOLL_BOOTH_DB_PATH` | ./toll-booth.db | SQLite database path |
| `ROOT_KEY` | — | Macaroon signing key (hex, 64 chars / 32 bytes). **Required for production.** |
| `TRUST_PROXY` | false | Trust `X-Forwarded-For` / `X-Real-IP` headers |
| `MAX_PENDING_PER_IP` | unset | If set, cap pending unpaid invoices per client IP (rate-limit /create-invoice abuse) |
| `INVOICE_MAX_AGE_MS` | 3600000 | Max age of stored invoices in milliseconds before hourly auto-prune deletes them. Default 1 hour in this example; the library default is 24 hours. |
| `PORT` | 3000 | HTTP listen port |
| `LND_REST_URL` | — | LND REST endpoint (integration tests) |
| `LND_MACAROON` | — | LND admin macaroon, hex (integration tests) |
| `CLN_REST_URL` | — | CLN REST endpoint (integration tests) |
| `CLN_RUNE` | — | CLN rune token (integration tests) |

## Conventions

- **British English** — colour, initialise, behaviour, licence
- **ESM-only** — `"type": "module"`, target ES2022, module Node16
- **Git:** commit messages use `type: description` format
- **Git:** Do NOT include `Co-Authored-By` lines in commits
- **Zero TROTT deps** — standalone library (better-sqlite3, macaroon, qrcode)
