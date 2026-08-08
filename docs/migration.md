# Migration Guide

## v4 to v5

**Breaking changes:** IETF Payment credential format, `X402Facilitator` interface, `RailVerifyResult` shape.

### Why

v5 is a security-hardening release. A full review of the payment flow found that stateless credentials were not bound to the route they paid for, top-up proofs could be replayed for extra credit, and currency mismatches could resolve to a zero cost. v5 closes these at the protocol level, which requires format changes.

### What to change

**IETF Payment clients:** charge credentials now carry a `resource` field bound into the HMAC challenge. Credentials minted before v5 are rejected — clients must request a fresh challenge. Session top-up payment hashes are single-use; retrying a top-up requires a new invoice.

**Custom x402 facilitators:** `verify()` now receives the full payment requirements as a second argument. Check `amount`, `network`, `asset` and `payTo` against it (the built-in rail also enforces these around your callback):

```typescript
// v4
verify: async (payload) => { /* ... */ }

// v5
verify: async (payload, requirements) => { /* ... */ }
```

**Custom payment rails:** `RailVerifyResult` gains `amountPaid`. Populate it so the engine can reject underpaid settlements; omitting it disables that check for your rail.

### Behaviour changes (non-breaking)

- Request paths are normalised before pricing lookup (`/api/joke/` and `/api/joke` are priced identically). If you relied on trailing-slash variants being unpriced, set `strictPricing: true` and price the canonical path.
- A one-time startup warning is printed when pricing is configured and `strictPricing` is off.
- x402 (USD) credentials on sats-only routes (and vice versa) are now challenged instead of proxied at zero cost.

---

## v2 to v3

**Breaking change:** `RequestEvent` and `ChallengeEvent` no longer include the `clientIp` field.

### Why

v3 introduced privacy-by-design IP handling. IP addresses are now one-way hashed with a daily-rotating salt before any processing. Exposing raw IPs via event hooks contradicted this principle, so the field was removed.

### What to change

If your `onRequest` or `onChallenge` callbacks reference `event.clientIp`, remove those references:

```typescript
// v2
onRequest: (event) => {
  console.log(`${event.endpoint} from ${event.clientIp}`)
}

// v3
onRequest: (event) => {
  console.log(`${event.endpoint} | ${event.satsDeducted} sats`)
}
```

If you need client identification for analytics, use the `getClientIp` callback at the `Booth` level to hash or anonymise IPs yourself before they reach your logging pipeline.

### Other v3 changes (non-breaking)

- IP addresses are one-way hashed in free-tier tracking (no raw IPs stored in memory)
- Free-tier IP hashing uses a daily-rotating salt; hashes cannot be correlated across days

---

## v1 to v2

**Breaking change:** The Alby/NWC backend was replaced with a proper NWC backend using NIP-44 encryption.

### What changed

| v1 | v2 |
|----|-----|
| `import { albyBackend } from '@forgesworn/toll-booth/backends/alby'` | `import { nwcBackend } from '@forgesworn/toll-booth/backends/nwc'` |
| `AlbyConfig` | `NwcConfig` |
| `albyBackend(config)` | `nwcBackend(config)` |
| Unauthenticated JSON relay transport | NIP-44 encrypted Nostr relay transport |
| Required `allowInsecureRelay: true` | Secure by default |

### Why

The v1 Alby backend used an unauthenticated JSON relay transport that required an explicit `allowInsecureRelay: true` opt-in. This was a stopgap; the v2 NWC backend uses proper NIP-44 encryption via Nostr relays, making it secure by default and compatible with any NWC wallet (Alby Hub, Mutiny, Umbrel, Phoenix, and more).

### What to change

```typescript
// v1
import { albyBackend } from '@forgesworn/toll-booth/backends/alby'

const backend = albyBackend({
  nwcUrl: 'nostr+walletconnect://...',
  allowInsecureRelay: true,
})

// v2
import { nwcBackend } from '@forgesworn/toll-booth/backends/nwc'

const backend = nwcBackend({
  nwcUrl: 'nostr+walletconnect://...',
})
```

The `nwcUrl` format is the same. Remove `allowInsecureRelay` as it is no longer needed.
