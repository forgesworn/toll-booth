NIP-XXX
======

Paid HTTP Service Announcements
-------------------------------

`draft` `optional`

This NIP defines kind `31402` (a parameterized replaceable event) for advertising paid HTTP services on Nostr. Services publish what they offer, what it costs, and how they accept payment. Clients discover services by topic, capability, or text search via relay filters.

This NIP covers discovery and capability advertising only. Payment flow is delegated to the underlying payment protocol (L402, x402, NWC, etc.) and is explicitly out of scope.

## Event Kind

Kind `31402` — parameterized replaceable event ([NIP-33](33.md)).

`30000 + 1402` references HTTP 402 Payment Required.

Relays store exactly one event per `pubkey` + `d` tag combination. Re-publishing with the same `d` tag replaces the previous listing.

## Tags

| Tag | Format | Required | Purpose |
|-----|--------|----------|---------|
| `d` | `["d", "<identifier>"]` | Yes | Unique listing ID per pubkey ([NIP-33](33.md)). Free-form string. |
| `name` | `["name", "<display-name>"]` | Yes | Human-readable service name |
| `url` | `["url", "<endpoint>"]` | Yes | Base URL of the service |
| `about` | `["about", "<description>"]` | Yes | Short description of what the service does |
| `pmi` | `["pmi", "<method>"]` | Yes (1+) | Payment method identifier. Repeatable. |
| `price` | `["price", "<capability>", "<amount>", "<currency>"]` | No | Per-capability pricing. Repeatable. |
| `t` | `["t", "<topic>"]` | No | Topic tags for relay-side filtering. Repeatable. |
| `status` | `["status", "UP\|DOWN\|CLOSED"]` | No | Self-reported service availability. |
| `picture` | `["picture", "<url>"]` | No | Service icon or logo URL |

### Tag Conventions

**`url` tag:** The base URL of the service. Clients append capability-specific paths as needed. For single-endpoint services, this is the full endpoint URL.

**`status` tag:** If omitted, clients SHOULD assume `UP`.

**`price` tag:** Amounts are string integers in the smallest currency unit. Capability names MUST match a corresponding `capabilities[].name` in the content JSON when both are present.

### Currency Identifiers

Recommended currency strings for the `price` tag:

| Identifier | Unit | Description |
|------------|------|-------------|
| `sats` | satoshi | Bitcoin (Lightning, on-chain) |
| `msats` | millisatoshi | Bitcoin (sub-satoshi precision) |
| `usd` | cent | US Dollar |
| `eur` | cent | Euro |

Implementations SHOULD use these identifiers for interoperability. Custom currency strings are permitted.

### Payment Method Identifiers

The `pmi` tag uses extensible string identifiers. Recommended values:

- `bitcoin-lightning-bolt11` — Lightning BOLT-11 invoices
- `bitcoin-cashu` — Cashu ecash tokens
- `x402-usdc-base` — x402 USDC on Base
- `x402-usdc-ethereum` — x402 USDC on Ethereum

Any string is valid. Clients filter by payment methods their wallet supports.

## Content

JSON string with optional extended metadata:

```json
{
  "capabilities": [
    {
      "name": "standard-joke",
      "description": "Solid jokes across 6 topics",
      "schema": {},
      "outputSchema": {}
    }
  ],
  "version": "1.0.0"
}
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `capabilities` | array | No | List of capabilities with optional JSON schemas |
| `capabilities[].name` | string | Yes | Capability identifier (matches `price` tag capability) |
| `capabilities[].description` | string | No | Human-readable description |
| `capabilities[].schema` | object | No | JSON Schema for request body |
| `capabilities[].outputSchema` | object | No | JSON Schema for response body |
| `version` | string | No | Service version |

All essential discovery data lives in tags. Content is supplementary. If no extended metadata is needed, content SHOULD be `{}` (empty JSON object).

Capability names in the content JSON MUST match the corresponding `price` tag capability names when both are present. Capabilities MAY appear in content without a `price` tag (free capabilities) or in `price` tags without content detail (priced but undescribed).

JSON schemas are optional but recommended. When present, clients can construct valid requests from the announcement without probing the endpoint.

## Discovery

### Relay-Side Filtering

Clients SHOULD use filter syntax to let relays reduce bandwidth:

```json
{"kinds": [31402], "#t": ["jokes"]}
{"kinds": [31402], "#pmi": ["bitcoin-lightning-bolt11"]}
```

### Client-Side Filtering

After relay filtering, clients MAY further narrow results by:
- Text search across `name`, `about`, capability names and descriptions
- Payment method matching against wallet capabilities
- Status filtering (skip DOWN/CLOSED services)
- NIP-05 trust verification

## Trust

Implementations SHOULD verify that the pubkey's [NIP-05](05.md) identifier domain matches the `url` tag domain. This provides a cheap anti-spoofing signal: a service claiming to be at `https://example.com` should have a NIP-05 on `example.com`.

Clients MAY maintain whitelists of trusted service providers.

## Example

```json
{
  "kind": 31402,
  "pubkey": "<pubkey>",
  "created_at": 1710446400,
  "tags": [
    ["d", "sats-for-laughs-jokes.trotters.dev"],
    ["name", "sats-for-laughs"],
    ["url", "https://jokes.trotters.dev"],
    ["about", "Lightning-paid joke API with cracker, standard, and premium jokes across 6 topics"],
    ["pmi", "bitcoin-lightning-bolt11"],
    ["pmi", "bitcoin-cashu"],
    ["price", "cracker-joke", "5", "sats"],
    ["price", "standard-joke", "21", "sats"],
    ["price", "premium-joke", "42", "sats"],
    ["t", "jokes"],
    ["t", "humor"],
    ["t", "bitcoin"],
    ["t", "lightning"],
    ["status", "UP"]
  ],
  "content": "{\"capabilities\":[{\"name\":\"cracker-joke\",\"description\":\"Bad puns and groaners\"},{\"name\":\"standard-joke\",\"description\":\"Solid jokes across 6 topics\"},{\"name\":\"premium-joke\",\"description\":\"Top-shelf comedy\"}],\"version\":\"1.0.0\"}",
  "id": "<id>",
  "sig": "<sig>"
}
```

## Relationship to Other NIPs

- **[NIP-90](90.md) (DVMs):** Complementary. DVMs handle Nostr-native compute jobs (intent-based, relay-mediated). This NIP handles HTTP API discovery (offer-based, out-of-band execution).
- **[NIP-89](89.md) (App Handlers):** Orthogonal. NIP-89 routes unknown event kinds to handler apps. This NIP advertises paid HTTP services.
- **[NIP-33](33.md):** This NIP uses parameterized replaceable events.
- **[NIP-05](05.md):** Recommended for trust verification (domain matching).

## Reference Implementations

- [402-announce](https://github.com/TheCryptoDonkey/402-announce) — Kind 31402 event publisher (TypeScript)
- [402-mcp](https://github.com/TheCryptoDonkey/402-mcp) — AI agent discovery client (TypeScript)
- [toll-booth](https://github.com/TheCryptoDonkey/toll-booth) — L402/x402 payment middleware (TypeScript)
- [satgate](https://github.com/TheCryptoDonkey/satgate) — Lightning-paid AI inference gateway (TypeScript)
