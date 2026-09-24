# AGENTS.md - toll-booth

AI agent instructions for working with this codebase.

L402 middleware: gates any HTTP API behind Lightning payments. Supports Express, Web Standard (Deno, Bun, Cloudflare Workers), and Hono.

## Commands

```bash
npm run build       # tsc -> dist/
npm test            # vitest run (unit tests, no env vars needed)
npm run typecheck   # tsc --noEmit
```

Integration tests require Docker or live backend credentials:

```bash
npm run test:integration          # full stack: bitcoind + 2 LND nodes + Cashu mint
npm run test:integration:ln       # Lightning only
npm run test:integration:cashu    # Cashu only
LND_REST_URL=... LND_MACAROON=... npm test -- src/backends/lnd.integration.test.ts
CLN_REST_URL=... CLN_RUNE=... npm test -- src/backends/cln.integration.test.ts
PHOENIXD_URL=... PHOENIXD_PASSWORD=... npm test -- src/backends/phoenixd.integration.test.ts
```

Backend conformance tests (`conformance.ts`) export a shared factory; each backend's integration test uses it.

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
  cli.ts                    # CLI entry point (demo, init)
  init.ts                   # Interactive project scaffolder
  init-prompts.ts           # CLI prompts and flag parsing for init
  templates/                # Generated project templates (Express, Hono, Deno, etc.)
  core/
    toll-booth.ts           # TollBoothEngine: framework-agnostic L402 payment flow
    payment-rail.ts         # PaymentRail interface and pricing normalisation
    l402-rail.ts            # L402 Lightning + macaroon payment rail
    x402-rail.ts            # x402 on-chain stablecoin payment rail
    xcashu-rail.ts          # xcashu (NUT-24) direct-header payment rail
    lnurlcash-rail.ts       # lnurlcash payment rail
    ietf-payment.ts         # IETF Payment auth rail (draft-ryan-httpauth-payment-01)
    ietf-session.ts         # IETF Payment session intent rail
    create-invoice.ts       # POST /create-invoice handler (tier support)
    invoice-status.ts       # GET /invoice-status/:paymentHash handler
    cashu-redeem.ts         # Cashu token redemption with lease/recovery logic
    melt-to-lightning.ts    # Cashu-to-Lightning melt utility
  storage/
    interface.ts            # StorageBackend interface (credits, invoices, claims)
    sqlite.ts               # SQLite implementation (better-sqlite3, WAL mode)
    memory.ts                # In-memory implementation (tests, ephemeral use)
  adapters/
    express.ts               # Express 5 middleware + handlers
    web-standard.ts          # Web Standard (Request/Response) handlers (Deno, Bun, Workers)
    hono.ts                  # Hono middleware + payment route sub-app
    proxy-headers.ts         # X-Forwarded-For / X-Real-IP parsing
  backends/
    phoenixd.ts               # Phoenixd Lightning backend (HTTP API)
    lnd.ts                     # LND Lightning backend (REST API)
    cln.ts                     # Core Lightning backend (clnrest API)
    lnbits.ts                  # LNbits Lightning backend (REST API)
    nwc.ts                     # Merchant Nostr Wallet Connect (NIP-47) backend
    conformance.ts             # Shared backend conformance test factory
  e2e/                       # End-to-end integration tests
examples/
  sats-for-laughs/          # Complete joke API deployment (live at jokes.forgesworn.dev)
  valhalla-proxy/           # Docker Compose reference (Express + Phoenixd)
```

## Architecture

**Payment flow:**
1. Client requests priced endpoint without L402 header
2. Free tier checked (per-IP, per-day allowance)
3. If exhausted, a 402 response is returned with a BOLT-11 invoice + macaroon
4. Client pays (Lightning, NWC, or Cashu), obtains preimage or settlement secret
5. Client sends `Authorization: L402 <macaroon>:<preimage>`
6. Macaroon verified, credit granted, request proxied upstream with `X-Credit-Balance` header

**Booth class** is a facade that wires together the engine, storage, and adapter. Constructor takes `adapter: 'express' | 'web-standard' | 'hono'` to select framework integration. One `new Booth(config)` call exposes `.middleware`, `.invoiceStatusHandler`, `.createInvoiceHandler`, and optional payment handlers such as `.cashuRedeemHandler`. For Hono, use `createHonoTollBooth()` directly for more idiomatic integration (auth middleware + payment route sub-app).

**Hono adapter** (`createHonoTollBooth()`) provides an auth middleware and a `createPaymentApp()` factory that returns a Hono sub-app with `/create-invoice`, `/invoice-status/:paymentHash`, and optional `/cashu-redeem` routes. Context variables (`TollBoothEnv`) expose payment state to downstream handlers.

**Core engine** (`createTollBooth()`) is framework-agnostic; adapters translate between framework requests and `TollBoothRequest`/`TollBoothResult`. Core handlers (`handleCreateInvoice`, `handleCashuRedeem`) follow the same pattern.

**Payment rails** are pluggable via the `PaymentRail` interface. Built-in rails: L402 (Lightning + macaroon), x402 (on-chain stablecoins), xcashu (NUT-24 direct-header), lnurlcash, and IETF Payment (draft-ryan-httpauth-payment-01, stateless Lightning). Multiple rails can run simultaneously on a single deployment.

**Storage** is abstracted via `StorageBackend` interface. SQLite (WAL mode, better-sqlite3) is the default; `memoryStorage()` available for tests. Three tables: `credits` (balance ledger), `invoices`, `cashu_claims` (redemption leases).

**Backends:** Phoenixd, LND, CLN, LNbits, and NWC. All implement the `LightningBackend` interface. Cashu-only mode works without any Lightning backend.

**Payment connectors:** NWC is an operator-owned Lightning backend. Cashu redemption is an optional client payment method via `redeemCashu` and includes lease-based crash recovery. Never accept a payer NWC URI over HTTP.

**Volume discounts:** Credit tiers (e.g. pay 10k sats, get 11.1k credits).

**Invoice expiry:** Automatic hourly pruning of invoices older than `invoiceMaxAgeMs` (default 24h).

## Environment variables (valhalla-proxy example)

| Variable | Default | Description |
|----------|---------|-------------|
| `PHOENIXD_URL` | - | Phoenixd HTTP endpoint |
| `PHOENIXD_PASSWORD` | - | Phoenixd auth password |
| `VALHALLA_URL` | - | Upstream API to proxy |
| `FREE_TIER_REQUESTS` | 10 | Daily free requests per IP |
| `DEFAULT_INVOICE_SATS` | 1000 | Default invoice amount |
| `TOLL_BOOTH_DB_PATH` | ./toll-booth.db | SQLite database path |
| `ROOT_KEY` | - | Macaroon signing key (hex, 64 chars / 32 bytes). Required for production. |
| `TRUST_PROXY` | false | Trust `X-Forwarded-For` / `X-Real-IP` headers |
| `MAX_PENDING_PER_IP` | unset | If set, cap pending unpaid invoices per client IP (rate-limit /create-invoice abuse) |
| `INVOICE_MAX_AGE_MS` | 3600000 | Max age of stored invoices in milliseconds before hourly auto-prune deletes them. Default 1 hour in this example; the library default is 24 hours. |
| `PORT` | 3000 | HTTP listen port |
| `LND_REST_URL` | - | LND REST endpoint (integration tests) |
| `LND_MACAROON` | - | LND admin macaroon, hex (integration tests) |
| `CLN_REST_URL` | - | CLN REST endpoint (integration tests) |
| `CLN_RUNE` | - | CLN rune token (integration tests) |

## Conventions

- British English: colour, initialise, behaviour, licence
- ESM-only: `"type": "module"`, target ES2022, module Node16
- Commits use `type: description` format (e.g. `feat:`, `fix:`, `refactor:`, `docs:`)
- Do not include `Co-Authored-By` lines in commits
- Tests are co-located with source (`src/foo.test.ts` alongside `src/foo.ts`)
- Integration tests live in `src/e2e/` and `src/backends/*.integration.test.ts`

## Key patterns

- All database queries use parameterised prepared statements (no dynamic SQL)
- Payment hashes are validated as 64-char lowercase hex
- Macaroon root key must be 32 bytes (64 hex chars) for production
- Cashu redemption uses lease-based crash recovery
- Free tier tracks IPs via one-way hashing (no PII stored)
- Header injection prevention: caveat keys restricted to `[a-zA-Z0-9_]`, values have CR/LF stripped
- Request body size capped at 64 KiB across all adapters
