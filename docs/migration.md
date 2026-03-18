# Migration Guide

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
