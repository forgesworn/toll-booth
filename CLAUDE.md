# CLAUDE.md — toll-booth

L402 middleware — gates any Hono HTTP API behind Lightning payments. Drop-in, one function call.

## Commands

```bash
npm run build       # tsc → dist/
npm test            # vitest run (10 test files)
npm run typecheck   # tsc --noEmit
```

## Structure

```
src/
  index.ts              # Public API exports
  types.ts              # LightningBackend, BoothConfig, Invoice, CreditTier
  booth.ts              # Booth class: composable facade (middleware + handlers + state)
  middleware.ts          # L402 middleware handler (core payment flow)
  meter.ts              # CreditMeter: SQLite debit/credit ledger
  invoice-store.ts      # InvoiceStore: SQLite invoice persistence
  macaroon.ts           # Macaroon minting, verification, caveat parsing
  free-tier.ts          # Per-IP daily allowance tracking (in-memory)
  create-invoice.ts     # POST /create-invoice handler (tier support)
  invoice-status.ts     # GET /invoice-status/:paymentHash handler
  payment-page.ts       # Self-service HTML payment UI (QR, tier selector, wallet adapters)
  stats.ts              # StatsCollector: in-memory usage analytics
  backends/
    phoenixd.ts         # Phoenixd Lightning backend (HTTP API)

examples/
  valhalla-proxy/       # Complete Docker Compose reference deployment
```

## Architecture

**Payment flow:**
1. Client requests priced endpoint without L402 header
2. Free tier checked (per-IP, per-day allowance)
3. If exhausted → 402 response with BOLT-11 invoice + macaroon
4. Client pays, obtains preimage
5. Client sends `Authorization: L402 <macaroon>:<preimage>`
6. Macaroon verified, credit granted, request proxied upstream with `X-Credit-Balance` header

**Booth class** encapsulates everything: middleware, invoice/status handlers, NWC/Cashu adapters, stats, free-tier reset. One `new Booth(config)` call.

**Persistence:** SQLite (better-sqlite3, WAL mode). Two tables: `credits` (balance ledger) + `invoices`.

**Backends:** Phoenixd implemented. LND/Alby planned.

**Volume discounts:** Credit tiers (e.g. pay 10k sats, get 11.1k credits).

**Wallet adapters:** Optional NWC + Cashu payment methods (pluggable via callbacks).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PHOENIXD_URL` | — | Phoenixd HTTP endpoint |
| `PHOENIXD_PASSWORD` | — | Phoenixd auth password |
| `VALHALLA_URL` | — | Upstream API to proxy |
| `FREE_TIER_REQUESTS` | 1000 | Daily free requests per IP |
| `DEFAULT_INVOICE_SATS` | 1000 | Default invoice amount |
| `DB_PATH` | ./toll-booth.db | SQLite database path |
| `ROOT_KEY` | — | Macaroon signing key (hex, 64 chars / 32 bytes). **Required for production.** |
| `ADMIN_TOKEN` | — | Bearer token for `/stats` and `/admin/*` endpoints |
| `TRUST_PROXY` | false | Trust `X-Forwarded-For` / `X-Real-IP` headers |
| `PORT` | 3000 | HTTP listen port |

## Conventions

- **British English** — colour, initialise, behaviour, licence
- **ESM-only** — `"type": "module"`, target ES2022, module Node16
- **Git:** commit messages use `type: description` format
- **Git:** Do NOT include `Co-Authored-By` lines in commits
- **Zero TROTT deps** — standalone library (hono, better-sqlite3, macaroon)
