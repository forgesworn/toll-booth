# Contributing to toll-booth

Welcome! toll-booth is an L402 middleware that gates any HTTP API behind Lightning payments. Whether you are fixing a typo, adding a backend, or improving tests, contributions are appreciated.

New here? Look for issues labelled **good-first-issue** - they are scoped, self-contained tasks designed for first-time contributors.

## Development setup

```bash
git clone https://github.com/forgesworn/toll-booth.git
cd toll-booth
npm install
npm run build       # tsc -> dist/
npm test            # vitest (unit tests)
npm run typecheck   # tsc --noEmit
```

Node 18+ is required. The project is ESM-only (`"type": "module"`).

## Project structure

```
src/
  index.ts                  # Public API exports
  types.ts                  # Core interfaces (LightningBackend, BoothConfig, etc.)
  booth.ts                  # Booth facade class
  macaroon.ts               # Macaroon minting and verification
  free-tier.ts              # Per-IP daily allowance tracking
  payment-page.ts           # Self-service HTML payment UI
  core/                     # Framework-agnostic L402 engine and handlers
  storage/                  # StorageBackend implementations (SQLite, memory)
  adapters/                 # Express, Web Standard, and Hono middleware
  backends/                 # Lightning backend implementations + conformance tests
  e2e/                      # End-to-end integration tests
examples/
  valhalla-proxy/           # Complete Docker Compose reference deployment
```

See `CLAUDE.md` for a more detailed breakdown of every file.

## Testing

Unit tests are **co-located** with source files - `src/foo.test.ts` sits alongside `src/foo.ts`. Integration tests live in `src/e2e/` and `src/backends/*.integration.test.ts`.

```bash
npm test                        # All unit tests (no env vars needed)
npm test -- src/macaroon.test.ts   # Run a specific test file
```

### Integration tests

Integration tests require running backends and are skipped automatically when env vars are missing.

```bash
# Full stack (Docker): bitcoind + 2 LND nodes + Cashu mint
npm run test:integration

# Lightning only / Cashu only
npm run test:integration:ln
npm run test:integration:cashu

# Individual backend (provide your own credentials)
LND_REST_URL=... LND_MACAROON=... npm test -- src/backends/lnd.integration.test.ts
CLN_REST_URL=... CLN_RUNE=... npm test -- src/backends/cln.integration.test.ts
PHOENIXD_URL=... PHOENIXD_PASSWORD=... npm test -- src/backends/phoenixd.integration.test.ts
```

The integration test script (`scripts/test-integration.sh`) handles Docker orchestration - container startup, regtest blockchain setup, channel funding, and cleanup.

## Code style

- **British English** - colour, initialise, behaviour, licence
- **ESM-only** - target ES2022, module Node16
- **Follow existing patterns** - look at neighbouring files before writing new code
- **Zero TROTT dependencies** - toll-booth is a standalone library

## Pull requests

- Keep PRs focused; one feature or fix per PR
- Write descriptive commit messages using `type: description` format (e.g. `feat:`, `fix:`, `refactor:`, `docs:`)
- Include tests for new features and bug fixes
- All checks must pass: `npm test` and `npm run typecheck`
- Prefer small, reviewable diffs over large sweeping changes

## Adding a Lightning backend

toll-booth ships with Phoenixd, LND, CLN, LNbits, and NWC backends. To add another:

1. Create `src/backends/yourbackend.ts` implementing the `LightningBackend` interface (two methods: `createInvoice` and `checkInvoice`)
2. Create `src/backends/yourbackend.test.ts` with unit tests mocking the HTTP layer
3. Use the shared conformance test factory in `src/backends/conformance.ts` for integration tests - it validates consistent behaviour across all backends
4. Add a subpath export in `package.json` under `exports`
5. Add to the backend table in `README.md`

## Adding a payment rail

Payment rails and redemption methods live in `src/core/` as framework-agnostic handlers. The pattern:

1. Define request/result types in `src/core/types.ts`
2. Implement the handler in `src/core/your-rail.ts`
3. Wire it through adapters (Express, Web Standard, Hono) so each framework exposes the route
4. Add integration tests in `src/e2e/`

Look at `src/core/cashu-redeem.ts` or the `PaymentRail` implementations as references. NWC is a merchant Lightning backend under `src/backends/`, not a payment rail.
