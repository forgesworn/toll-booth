# Agent-Friendly 402 Response Bodies

**Date:** 2026-03-17
**Status:** Draft
**Scope:** toll-booth core — response body enrichment

## Problem

An AI agent encountering a toll-booth 402 response gets payment data (invoice, macaroon, amount) but no context about the service itself or how to construct the auth header. The agent can pay but can't answer: "What am I buying?" or "How do I present the token after payment?"

## Solution

Add three optional fields to the 402 response body. Zero breaking changes — fields appear only when configured.

## Config Changes

### BoothConfig

One new optional field. The existing `serviceName` field (used in Lightning invoice descriptions) is reused as the `booth.name` value — no second name field.

```typescript
interface BoothConfig {
  // ...existing fields...
  // serviceName already exists — used for booth.name

  /** Service description shown in 402 responses. */
  description?: string
}
```

When `serviceName` is set, the `booth` block and `auth_hint` appear in 402 responses. `description` is optional additional context.

### CreditTier

One new optional field:

```typescript
interface CreditTier {
  // ...existing fields...

  /** What the agent gets for this tier, e.g. "1 request", "10 minutes access". */
  yields?: string
}
```

## 402 Response Body

When `serviceName` is configured, the response body includes `booth` and `auth_hint`:

```json
{
  "message": "Payment required.",
  "booth": {
    "name": "Lightning Graph API",
    "description": "Network intelligence and channel suggestions"
  },
  "auth_hint": "Pay the invoice, then send header — Authorization: L402 <macaroon>:<preimage>",
  "l402": {
    "invoice": "lnbc...",
    "macaroon": "AgEB...",
    "payment_hash": "abcdef...",
    "amount_sats": 10
  },
  "tiers": {},
  "credit_tiers": [
    {
      "amountSats": 10,
      "creditSats": 10,
      "label": "Basic",
      "yields": "1 request"
    }
  ]
}
```

When `serviceName` is not configured, the body is unchanged from today. The `booth` and `auth_hint` fields are omitted entirely.

**Note:** The existing response body uses snake_case in the `l402` block (`payment_hash`, `amount_sats`) and camelCase in `credit_tiers` (`amountSats`, `creditSats`). This mixed convention predates this spec. The new `booth` and `auth_hint` fields use snake_case at the top level, consistent with the `l402` block. `credit_tiers` items retain their existing camelCase convention. `yields` follows the existing camelCase convention of `CreditTier`.

## Code Changes

### 1. `src/types.ts`

- Add `description?: string` to `BoothConfig`
- Add `yields?: string` to `CreditTier`

### 2. `src/core/types.ts`

- Add `description?: string` to `TollBoothCoreConfig` (alongside existing `serviceName`)

### 3. `src/booth.ts`

- Forward `config.serviceName` and `config.description` when constructing the `TollBoothCoreConfig` object

### 4. `src/core/toll-booth.ts` (lines 84-134)

In the response body assembly, after existing fields:

```typescript
if (config.serviceName) {
  body.booth = {
    name: config.serviceName,
    ...(config.description && { description: config.description }),
  }
  body.auth_hint = 'Pay the invoice, then send header — Authorization: L402 <macaroon>:<preimage>'
}
```

### 5. Hono adapter

The Hono adapter (`src/adapters/hono.ts`) takes a pre-built `engine` via `HonoTollBoothConfig`, so `booth` and `auth_hint` are already included in 402 responses from the engine. No Hono adapter changes needed — verify only.

### 6. Tests

- Verify `booth` and `auth_hint` present when `serviceName` configured
- Verify `booth.name` matches `serviceName` value
- Verify `booth.description` present when `description` configured, absent when not
- Verify `auth_hint` is the exact string `'Pay the invoice, then send header — Authorization: L402 <macaroon>:<preimage>'`
- Verify `booth` and `auth_hint` absent when `serviceName` not configured
- Verify `yields` appears in `credit_tiers` when set on a tier
- Verify existing 402 body shape unchanged when no new fields configured

## What Doesn't Change

- Payment rails (L402, x402, xcashu)
- Storage (SQLite, memory)
- Lightning backends
- Payment flow
- Existing 402 body fields

## Non-Goals

- Discovery endpoint (`/.well-known/l402`) — separate future work
- Consumption type hints beyond the `yields` string — YAGNI
- Multi-rail auth format strings — `auth_hint` is L402-only for now; x402 and xcashu have different auth mechanisms

## Future Considerations

The `booth` object is intentionally extensible. Future iterations could add:
- `rails: string[]` — accepted payment rails (l402, x402, xcashu)
- `docs: string` — link to API documentation
- `endpoints: Record<string, { path, price_sats }>` — machine-readable endpoint catalogue

These are out of scope for this spec but the `booth` namespace accommodates them cleanly.
