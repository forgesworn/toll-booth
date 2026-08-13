# GEMINI.md — toll-booth

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
  booth.ts                  # Booth class: facade that wires engine + adapters + storage
  macaroon.ts               # Macaroon minting, verification, caveat parsing
  free-tier.ts              # Per-IP daily allowance tracking (in-memory)
  payment-page.ts           # Self-service HTML payment UI (QR, tier selector, wallet adapters)
  stats.ts                  # StatsCollector: in-memory usage analytics
  cli.ts                    # CLI entry point (demo, init)
  init.ts                   # Interactive project scaffolder
  core/
    toll-booth.ts           # TollBoothEngine: framework-agnostic L402 payment flow
    payment-rail.ts         # PaymentRail interface and pricing normalisation
    l402-rail.ts            # L402 Lightning + macaroon payment rail
    x402-rail.ts            # x402 on-chain stablecoin payment rail
    xcashu-rail.ts          # xcashu (NUT-24) direct-header payment rail
    ietf-payment.ts         # IETF Payment auth rail (draft-ryan-httpauth-payment-01)
    ietf-session.ts         # IETF Payment session intent rail
    create-invoice.ts       # POST /create-invoice handler (tier support)
    invoice-status.ts       # GET /invoice-status/:paymentHash handler
    cashu-redeem.ts         # Cashu token redemption with lease/recovery logic
  storage/
    interface.ts            # StorageBackend interface (credits, invoices, claims)
    sqlite.ts               # SQLite implementation (better-sqlite3, WAL mode)
    memory.ts               # In-memory implementation (tests, ephemeral use)
  adapters/
    express.ts              # Express 5 middleware + handlers
    web-standard.ts         # Web Standard (Request/Response) handlers (Deno, Bun, Workers)
    hono.ts                 # Hono middleware + payment route sub-app
  backends/
    phoenixd.ts             # Phoenixd Lightning backend (HTTP API)
    lnd.ts                  # LND Lightning backend (REST API)
    cln.ts                  # Core Lightning backend (clnrest API)
    lnbits.ts               # LNbits Lightning backend (REST API)
    nwc.ts                  # Merchant Nostr Wallet Connect backend
    conformance.ts          # Shared backend conformance test factory
  e2e/                      # End-to-end integration tests
examples/
  sats-for-laughs/          # Complete joke API deployment (live at jokes.trotters.dev)
  valhalla-proxy/           # Docker Compose reference (Express + Phoenixd)
```

## Architecture

**Booth** is a facade that wires together the engine, storage, and adapter. One `new Booth(config)` call exposes `.middleware`, `.invoiceStatusHandler`, `.createInvoiceHandler`, and optional payment handlers.

**Core engine** (`createTollBooth()`) is framework-agnostic. Adapters translate between framework requests and `TollBoothRequest`/`TollBoothResult`.

**Payment rails** are pluggable via the `PaymentRail` interface. Built-in rails: L402 (Lightning + macaroon), x402 (on-chain stablecoins), xcashu (NUT-24 direct-header), and IETF Payment (draft-ryan-httpauth-payment-01). Multiple rails run simultaneously.

**Storage** is abstracted via `StorageBackend`. SQLite (WAL mode) is the default; `memoryStorage()` for tests.

**Backends** (Phoenixd, LND, CLN, LNbits, NWC) all implement the `LightningBackend` interface. Cashu-only mode works without any Lightning backend.

## Conventions

- **British English** — colour, initialise, behaviour, licence
- **ESM-only** — `"type": "module"`, target ES2022, module Node16
- **Commits** — `type: description` format (e.g. `feat:`, `fix:`, `refactor:`, `docs:`)
- **Tests** — co-located with source (`src/foo.test.ts` alongside `src/foo.ts`)
- **Zero TROTT deps** — standalone library
