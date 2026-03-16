# AGENTS.md - toll-booth

AI agent instructions for working with this codebase.

## Commands

```bash
npm run build       # tsc -> dist/
npm test            # vitest run (unit tests)
npm run typecheck   # tsc --noEmit
```

Integration tests require Docker:

```bash
npm run test:integration          # Full stack: bitcoind + 2 LND nodes + Cashu mint
npm run test:integration:ln       # Lightning only
npm run test:integration:cashu    # Cashu only
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
  core/
    toll-booth.ts           # TollBoothEngine: framework-agnostic L402 payment flow
    payment-rail.ts         # PaymentRail interface and pricing normalisation
    l402-rail.ts            # L402 Lightning + macaroon payment rail
    x402-rail.ts            # x402 on-chain stablecoin payment rail
    create-invoice.ts       # POST /create-invoice handler
    invoice-status.ts       # GET /invoice-status/:paymentHash handler
    nwc-pay.ts              # NWC payment handler
    cashu-redeem.ts         # Cashu token redemption with lease/recovery logic
  storage/
    interface.ts            # StorageBackend interface (credits, invoices, claims)
    sqlite.ts               # SQLite implementation (better-sqlite3, WAL mode)
    memory.ts               # In-memory implementation (tests, ephemeral use)
  adapters/
    express.ts              # Express 5 middleware + handlers
    web-standard.ts         # Web Standard (Request/Response) handlers
    hono.ts                 # Hono middleware + payment route sub-app
  backends/
    phoenixd.ts             # Phoenixd Lightning backend
    lnd.ts                  # LND Lightning backend (REST API)
    cln.ts                  # Core Lightning backend (clnrest API)
    lnbits.ts               # LNbits Lightning backend
    nwc.ts                  # Nostr Wallet Connect (NIP-47) backend
    conformance.ts          # Shared backend conformance test factory
  e2e/                      # End-to-end integration tests
examples/
  sats-for-laughs/          # Complete joke API deployment (live at jokes.trotters.dev)
  valhalla-proxy/           # Docker Compose reference (Express + Phoenixd)
```

## Architecture

**Booth** is a facade that wires together the engine, storage, and adapter. One `new Booth(config)` call exposes `.middleware`, `.invoiceStatusHandler`, `.createInvoiceHandler`, and optional payment handlers.

**Core engine** (`createTollBooth()`) is framework-agnostic. Adapters translate between framework requests and `TollBoothRequest`/`TollBoothResult`.

**Payment rails** are pluggable via the `PaymentRail` interface. Built-in rails: L402 (Lightning + macaroon) and x402 (on-chain stablecoins). Multiple rails can run simultaneously.

**Storage** is abstracted via `StorageBackend`. SQLite (WAL mode) is the default; `memoryStorage()` for tests.

**Backends** (Phoenixd, LND, CLN, LNbits, NWC) all implement the `LightningBackend` interface. Cashu-only mode works without any Lightning backend.

## Conventions

- **British English** - colour, initialise, behaviour, licence
- **ESM-only** - `"type": "module"`, target ES2022, module Node16
- **Commits** - `type: description` format (e.g. `feat:`, `fix:`, `refactor:`, `docs:`)
- **Tests** - co-located with source (`src/foo.test.ts` alongside `src/foo.ts`)
- **Integration tests** - in `src/e2e/` and `src/backends/*.integration.test.ts`

## Key patterns

- All database queries use parameterised prepared statements (no dynamic SQL)
- Payment hashes are validated as 64-char lowercase hex
- Macaroon root key must be 32 bytes (64 hex chars) for production
- Cashu redemption uses lease-based crash recovery
- Free tier tracks IPs via one-way hashing (no PII stored)
