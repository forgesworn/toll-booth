# Security Policy

## What toll-booth Does

toll-booth is L402 middleware that creates Lightning invoices, issues macaroon tokens, and proxies authorised requests to an upstream API. It handles payment credentials and access control.

## Sensitive Data

- **Macaroon root key** - used to sign and verify access tokens. If compromised, an attacker can mint arbitrary credentials. Use `ROOT_KEY` env var in production (not auto-generated). A warning is logged when the root key is auto-generated.
- **Lightning backend credentials** - `PHOENIXD_PASSWORD`, `LND_MACAROON`, `CLN_RUNE`, or `LNBITS_API_KEY` grant access to the Lightning node. Store securely; never commit to version control.
- **SQLite database** - contains invoice records, credit balances, and settlement secrets. Protect the `DB_PATH` file with appropriate filesystem permissions.

## Security Hardening

### Cryptography

- **Macaroon root key**: 32-byte (64 hex char) key, validated at startup. Auto-generated keys trigger a console warning.
- **Settlement secrets**: 32 bytes of cryptographically secure randomness (`crypto.randomBytes`), encoded as 64-char hex strings.
- **Status tokens**: 32 bytes of `crypto.randomBytes`, compared using `crypto.timingSafeEqual` to prevent timing side-channels.
- **Preimage verification**: Lightning preimages verified via `SHA-256(preimage) == paymentHash` using `crypto.timingSafeEqual`.

### Input Validation

- **Payment hashes**: Strictly validated as 64-char lowercase hex (`/^[0-9a-f]{64}$/`).
- **Credit balance**: Bounds-checked with `Number.isSafeInteger()` and non-negative constraint at macaroon verification time.
- **Invoice amounts**: Must be positive integers not exceeding 2,100,000,000,000,000 (total Bitcoin supply in sats).
- **Request body size**: Capped at 64 KiB across all adapters; `Content-Length` headers validated for format, non-negativity, and size.
- **Macaroon caveats**: Maximum 1024 characters per caveat. Reserved keys (`payment_hash`, `credit_balance`) rejected at mint time.
- **Status tokens**: Validated via timing-safe comparison in storage layer.
- **Merchant NWC URI**: Parsed strictly at startup, limited to authenticated key material and `wss://` relays, and never accepted in an HTTP request.
- **Cashu tokens**: Maximum 16,384 characters.
- **X-Toll-Cost header**: Strict integer format validation (`/^\d+$/`) prevents `parseInt` truncation attacks.

### Header Injection Prevention

- Custom macaroon caveat keys forwarded as `X-Toll-Caveat-*` headers are restricted to alphanumeric characters and underscores.
- Caveat values have CR/LF characters stripped to prevent HTTP response splitting.

### Rate Limiting

- **Free tier**: Per-IP daily allowance with configurable limit. Bounded to 100,000 tracked IPs to prevent memory exhaustion.
- **Invoice creation**: Optional `maxPendingPerIp` limits the number of unsettled invoices per client IP.

### Error Handling

- Backend error messages are truncated to 200 characters to prevent information leakage.
- Client-facing error responses use generic messages; details are logged server-side only.

### SQL Injection

All database queries use parameterised prepared statements. No dynamic SQL construction.

## No Telemetry

toll-booth does not phone home, collect analytics, or send data to any service other than the configured Lightning backend and upstream API.

## Reporting a Vulnerability

If you discover a security vulnerability, please email **security@trotters.cc** rather than opening a public issue. We will respond within 48 hours.

## Supported Versions

Only the latest major version receives security fixes.
