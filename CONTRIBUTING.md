# Contributing to toll-booth

## Setup

```bash
git clone https://github.com/forgesworn/toll-booth.git
cd toll-booth
npm install
```

## Development

```bash
npm run build       # tsc → dist/
npm test            # vitest (unit tests)
npm run typecheck   # tsc --noEmit
```

### Integration tests (requires Docker)

```bash
npm run test:integration          # Full stack: bitcoind + 2 LND nodes + Cashu mint
npm run test:integration:ln       # Lightning only
npm run test:integration:cashu    # Cashu only
```

The integration test script (`scripts/test-integration.sh`) handles all Docker orchestration — container startup, regtest blockchain setup, channel funding, macaroon extraction, and cleanup.

## Conventions

- **British English** — colour, initialise, behaviour, licence
- **ESM-only** — `"type": "module"`, target ES2022, module Node16
- **Commits** — `type: description` format (e.g. `feat:`, `fix:`, `refactor:`, `docs:`, `ci:`)
- **Tests** — co-located with source (`src/foo.test.ts` alongside `src/foo.ts`)
- **Integration tests** — in `src/e2e/` and `src/backends/*.integration.test.ts`, skipped without env vars

## Project structure

```
src/
  index.ts                  # Public API exports
  types.ts                  # Core interfaces (LightningBackend, BoothConfig, etc.)
  booth.ts                  # Booth facade class
  macaroon.ts               # Macaroon minting and verification
  core/                     # Framework-agnostic L402 engine and handlers
  storage/                  # StorageBackend implementations (SQLite, memory)
  adapters/                 # Express and Web Standard middleware factories
  backends/                 # Lightning backend implementations
  e2e/                      # End-to-end integration tests
examples/
  valhalla-proxy/           # Complete Docker Compose reference deployment
```

## Adding a Lightning backend

1. Create `src/backends/yourbackend.ts` implementing the `LightningBackend` interface (two methods: `createInvoice` and `checkInvoice`)
2. Create `src/backends/yourbackend.test.ts` with unit tests mocking the HTTP layer
3. Add a subpath export in `package.json` under `exports`
4. Add to the backend table in `README.md`

## Pull requests

- Keep PRs focused — one feature or fix per PR
- All unit tests must pass (`npm test`)
- New features should include tests
- Run `npm run typecheck` before submitting
