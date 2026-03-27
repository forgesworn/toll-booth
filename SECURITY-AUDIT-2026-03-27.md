# Security Audit Report: @forgesworn/toll-booth v4.4.2

**Date:** 2026-03-27
**Scope:** Full codebase review (src/, package.json, dependencies)
**Branch:** `security-audit-2026-03-27`
**Baseline:** 852 tests passing, 32 skipped (integration tests)

---

## Executive Summary

The codebase is in strong security shape. No critical, high, or medium severity vulnerabilities requiring code changes were found. The library demonstrates consistently sound security patterns across its crypto operations, payment verification, storage layer, and HTTP adapters. A previous security audit (commit `c45792e`) addressed foundational issues.

---

## Methodology

Three review areas were examined in depth:

1. **Crypto and Macaroon Security** -- `macaroon.ts`, key handling, timing-safe comparisons
2. **Payment and Storage Security** -- `toll-booth.ts`, `l402-rail.ts`, `storage/`, credit accounting, replay protection
3. **API Surface and Input Validation** -- `adapters/`, `booth.ts`, header parsing, injection vectors, error leakage

Additionally:
- Automated dependency audit (`npm audit`)
- Pattern scans for dangerous JS/TS constructs (`eval`, `__proto__`, `Math.random`, shell exec, dynamic `require`)
- Secrets scan for hardcoded credentials
- CI/CD audit (no workflows found locally; GitHub-side only)

---

## Dependency Audit

| Package | Severity | Dep Type | Relevant? |
|---------|----------|----------|-----------|
| handlebars 4.7.8 | critical | devDep (semantic-release) | No -- CI-only, not shipped |
| sjcl 1.0.8 | high | prod (via macaroon) | No -- ECC vuln, toll-booth uses HMAC-SHA256 |
| picomatch <2.3.2 | high | devDep (semantic-release, vitest) | No -- not shipped |
| yaml 2.8.2 | moderate | devDep (patch-package, vitest) | No -- not shipped |
| brace-expansion 4.x | moderate | bundled npm | No -- not relevant |

**Verdict:** No production-impactful vulnerabilities. The `sjcl` vulnerability (missing point-on-curve validation in ECC) does not affect HMAC-SHA256 macaroon operations. Worth tracking for upstream `macaroon` package updates.

---

## Positive Security Patterns (defences in place)

### Cryptographic Operations
- `crypto.randomBytes()` used for all security-sensitive values (root key auto-gen, settlement secrets, status tokens, bearer tokens, L402 identifiers, payment hashes in Cashu-only mode)
- `crypto.timingSafeEqual()` on all secret comparisons: status tokens, preimages, bearer tokens, settlement secrets, HMAC challenge IDs
- Length-independent timing-safe comparison with buffer padding (prevents length oracle)
- Random settlement secrets generated per settlement (raw preimages and txHashes never stored as bearer credentials)

### Macaroon Security
- Duplicate caveat detection prevents attacker-appended overrides
- First-occurrence-wins parsing (server-set caveats take precedence over appended caveats)
- Reserved caveat key protection (`payment_hash`, `credit_balance`, `currency`)
- Caveat count limit (max 16 custom)
- Caveat length limit (max 1024 chars)
- Binary L402 identifier with random 32-byte token ID
- Root key entropy detection and warning
- Root key format validation (exactly 64 hex chars)

### Replay Protection
- Settlement markers are **never pruned** (both SQLite and memory storage)
- `settleWithCredit` is atomic (returns false on race)
- Per-request mode uses `settle()` for one-time use credentials
- IETF session deposits are tied to payment hash (deterministic session ID prevents replay)
- Cashu claim-before-redeem with exclusive lease mechanism

### Input Validation
- `PAYMENT_HASH_RE` (/^[0-9a-f]{64}$/) enforced on all payment hash inputs across all adapters
- Status token length capped at 128 chars
- Cashu token length capped at 16,384 chars
- NWC URI scheme validation (`nostr+walletconnect://`) prevents SSRF
- NWC URI and BOLT11 length capped at 2,048 chars
- Body size limits enforced at 64KB across all adapters (Express, Web Standard, Hono)
- Streaming body reads with early abort on limit exceeded
- `amountSats` validated as safe integer in range [1, 2.1 quadrillion]
- Cashu overpayment rejection (credited > invoice amount)
- Negative credit amount rejection (RangeError)
- Tier name validation regex: `^[a-z0-9_-]{1,32}$`

### HTTP Security
- CRLF stripping on caveat-to-header forwarding (prevents header injection)
- Caveat key character validation (`^[a-zA-Z0-9_]+$` -- rejects hyphens, dots, specials)
- Proxy header stripping: authorization, host, hop-by-hop headers removed before upstream forwarding
- IP validation for X-Forwarded-For parsing (rejects non-IP strings, validates octet ranges)
- `Cache-Control: no-store` on all sensitive responses
- `X-Content-Type-Options: nosniff` on all responses
- CSP on HTML payment page: `default-src 'none'; frame-ancestors 'none'; form-action 'none'`
- `X-Frame-Options: DENY` on payment page
- Vary: Accept header for content negotiation
- Free-tier IP tracking bounded to 100,000 entries (prevents memory exhaustion)
- IP hashing with daily-rotating salt (raw IPs not stored)
- Backend error responses truncated to 200 chars
- NWC URIs redacted from error logs
- Generic error messages returned to clients (no internal details leaked)

### Session Security
- Refund-to-originator only (close-time return invoice override rejected)
- BOLT11 amount validation on refund invoices (prevents operator fund drain)
- TOCTOU protection on session close (close before refund payment)
- Deposit cap enforcement (maxDepositSats)
- Session expiry with auto-sweep
- Bearer token lookup uses timing-safe comparison (memory storage)
- Bearer token lookup uses indexed column (SQLite storage)

### Storage Safety
- SQLite WAL mode for concurrent reads
- Atomic transactions for settle-and-credit operations
- `INSERT OR IGNORE` for idempotent invoice storage
- Balance clamp to zero on over-deduction (prevents negative balances)
- Invoice pruning respects pending Cashu claims

---

## Informational Notes (no fix required)

### I-1: `Buffer.from()` without explicit encoding on token comparisons
- Locations: `storage/memory.ts:159-160`, `storage/sqlite.ts:517-518`
- `Buffer.from(statusToken)` defaults to UTF-8 encoding. Since tokens are hex strings, UTF-8 is functionally correct. The timing-safe comparison with padding handles the length check correctly.
- **Risk:** None. UTF-8 is the correct encoding for hex string comparisons.

### I-2: Memory storage `getSessionByBearer` linear scan
- The memory storage iterates all sessions for bearer token lookup (O(n) with timing-safe comparison each).
- This is by design -- memory storage is for tests and ephemeral use. SQLite uses an indexed lookup.
- **Risk:** Theoretical DoS if memory storage were used in production with many sessions. Mitigated by documentation and typical usage patterns.

### I-3: Geo-fence fail-open behaviour
- `isBlockedCountry()` returns `false` (allow) when the country header is absent.
- This is documented and intentional -- the reverse proxy/CDN is responsible for setting the header.
- **Risk:** An attacker who can strip the country header bypasses geo-fencing. This is a deployment concern, not a library concern.

### I-4: CSP includes `script-src 'unsafe-inline'`
- The payment page embeds inline JavaScript for the polling/payment UX. This requires `unsafe-inline`.
- Mitigated by: `default-src 'none'`, `frame-ancestors 'none'`, `form-action 'none'`, and HTML entity escaping on all user-controlled values via `esc()`.
- **Risk:** Low. XSS would require bypassing the HTML escaping function, which correctly handles `&`, `<`, `>`, `"`.

### I-5: sjcl dependency in macaroon package
- `macaroon@3.0.4` depends on `sjcl@1.0.8` which has a missing point-on-curve validation vulnerability (GHSA-2w8x-224x-785m).
- Toll-booth uses HMAC-SHA256 macaroons, not ECC operations, so this vulnerability is not exploitable.
- **Action:** Monitor for upstream `macaroon` package updates.

---

## Automated Scan Results

| Scan | Result |
|------|--------|
| `eval()` / `new Function()` | None found |
| `innerHTML` / `document.write()` | None found |
| `__proto__` / `constructor.prototype` | None found |
| Dynamic `require()` | None found |
| `Math.random()` for security | None found (only tests and demo joke picker) |
| Shell execution with concatenation | None found (only SQLite `db.exec()` with static SQL) |
| Hardcoded secrets/keys | None found (test files use `'a'.repeat(64)` etc.) |
| `.env` files in repo | None found (only `.env.example` files in examples) |
| Unbounded regex | None found |
| CI/CD expression injection | No workflows found locally |

---

## Conclusion

The library demonstrates consistently sound security engineering across all three review areas. The previous security audit (commit `c45792e`) established strong foundations, and subsequent development has maintained those patterns. No code changes are recommended.

**Overall Risk Assessment:** Low

**Recommended follow-up actions:**
1. Monitor `macaroon` package for sjcl update
2. Run `npm audit fix` to update devDependencies (handlebars, picomatch, yaml) -- these are CI-only and do not affect consumers
3. Consider adding a `npm audit` step to CI to catch future dependency vulnerabilities automatically
