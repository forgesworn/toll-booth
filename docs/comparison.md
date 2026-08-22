# HTTP 402 Middleware Comparison (March 2026)

An honest comparison of toll-booth against every alternative we know of. We believe developers make better decisions with complete information; where a competitor is stronger, we say so.

---

## Feature matrix

| Feature | toll-booth | Aperture | x402 v2 | Fewsats | Routstr |
|---------|-----------|----------|---------|---------|---------|
| **Payment rails** | L402, x402, Cashu, xcashu (NUT-24), LNURLcash (LUD-25), IETF Payment | L402 | x402 (stablecoins) | L402 | Cashu |
| **Lightning backends** | 5 (Phoenixd, LND, CLN, LNbits, NWC) | 1 (LND) | 0 | 0 (hosted) | 0 |
| **Framework support** | Express, Web Standard, Hono | Standalone proxy | Express (TS), Flask (Python), Gin (Go), Spring (Java) | Hosted API | N/A |
| **Credit/balance system** | Yes - persistent ledger (SQLite) | No | Yes - sessions via sign-in-with-x | Yes - account-based | No |
| **Volume discount tiers** | Yes | No | No | No | No |
| **Free tier** | Yes - configurable per-IP daily allowance | No | No | No | No |
| **Self-service payment page** | Yes - QR codes, tier selector, wallet buttons | No | No | Yes | No |
| **Cashu-only mode** | Yes - no Lightning node required | No | No | No | Yes |
| **Self-hosted** | Yes | Yes | Facilitator is Coinbase-hosted | No | Partial (relay-based) |
| **Production deployed** | Yes (jokes.trotters.dev, satgate) | Yes (Loop, Pool, LN node runner services) | Testnets only (March 2026) | Yes | Yes |
| **IETF Payment draft** | Yes (draft-ryan-httpauth-payment-01) | No | No | No | No |
| **AI agent support** | Yes (402-mcp, programmatic L402 flow) | No | Yes (Google A2A integration) | Yes (L402-python client) | No |
| **Privacy** | No accounts, no KYC, hashed IPs with rotating salt | No accounts, no KYC | Wallet address visible on-chain | Account required | Pseudonymous (Nostr) |
| **Language** | TypeScript (ESM) | Go | TS, Python, Go, Java SDKs | Python SDK | TypeScript |
| **Licence** | MIT | MIT | Apache 2.0 | Proprietary | MIT |

---

## When to use Aperture

[Aperture](https://github.com/lightninglabs/aperture) is Lightning Labs' own L402 reverse proxy. It has been running in production for years, gating Loop, Pool, and other Lightning Labs services. The Go codebase is mature and well-understood by the Lightning community. If your infrastructure is already built around LND and you want a standalone proxy that you drop in front of an existing service, Aperture is a solid choice.

The trade-off is flexibility. Aperture only speaks L402 with LND; there is no credit system, no Cashu, no stablecoin rail, and no way to embed the payment logic inside your application process. Configuration is YAML-based rather than programmatic. If you need volume discounts, free tiers, or want to run on CLN/Phoenixd/LNbits/NWC, you will need to look elsewhere.

Choose Aperture when you are all-in on LND, want a battle-tested Go binary, and prefer a standalone reverse proxy over embedded middleware.

## When to use x402

[x402](https://x402.org) is backed by Coinbase and has momentum that is hard to ignore: 60+ organisations (including Cloudflare and Google), multi-language SDKs (TypeScript, Python, Go, Java), ~27,000 weekly npm downloads, and integration with Google's Agent-to-Agent (A2A) protocol. If your users pay with stablecoins (USDC on Base, Polygon, or Solana) and you are comfortable with a Coinbase-hosted facilitator handling payment verification, x402 offers a well-supported path.

The trade-off is centralisation and currency scope. As of March 2026, the facilitator is Coinbase-hosted and only testnet deployments are publicly documented. There is no Lightning or Cashu rail; payments are on-chain stablecoins only. The `upto` scheme and sign-in-with-x sessions add capabilities toll-booth does not have, but they also introduce account-like state that some developers prefer to avoid.

Choose x402 when you want stablecoin payments, value the backing of a large corporate ecosystem, and are comfortable routing payment verification through a hosted facilitator.

## When to use toll-booth

toll-booth is designed for developers who want full control over their payment infrastructure. It embeds directly into your application (Express, Hono, Deno, Bun, Cloudflare Workers) or runs as a gateway in front of any HTTP service in any language. Five Lightning backends, Cashu ecash, xcashu (NUT-24), LNURLcash bearer notes (LUD-25), x402 stablecoins, and IETF Payment all run simultaneously; clients choose whichever rail they prefer. The credit ledger, volume discount tiers, and free tier work identically regardless of how the client paid.

The trade-off is ecosystem size. toll-booth is a single TypeScript library maintained by a small team. It does not have Aperture's years of production mileage at Lightning Labs, x402's corporate coalition, or Fewsats' integrated client ecosystem with credit card fallback. If you need credit card payments as a fallback rail, toll-booth does not offer that today.

Choose toll-booth when you want multi-rail payments, self-hosted infrastructure, embeddable middleware, privacy by design, and the flexibility to run on any Lightning backend or no Lightning backend at all.

---

## What about Fewsats?

[Fewsats](https://fewsats.com) is a hosted platform with an integrated client SDK (L402-python). It handles the full payment lifecycle as a managed service, including credit card fallback for users who do not have a Lightning wallet. The developer experience is streamlined if you are happy with a hosted model.

The trade-off is that Fewsats is not self-hostable. Your payment infrastructure runs on their servers, and you need an account. If you want to own your payment stack, run it on your own infrastructure, or avoid third-party dependencies, Fewsats is not the right fit.

## What about Routstr?

[Routstr](https://github.com/routstr) is a Cashu-powered AI inference marketplace that operates over Nostr. It is a vertical application for a specific use case (AI model access via ecash), not a general-purpose HTTP 402 middleware. If you are building an AI inference marketplace on Nostr with Cashu payments, Routstr is purpose-built for that. For general API monetisation, it is not a direct alternative.

---

## Summary

There is no single "best" solution; the right choice depends on your constraints. If you need LND and a standalone Go proxy, use Aperture. If you need stablecoins and a corporate ecosystem, use x402. If you need a hosted platform with credit card fallback, use Fewsats. If you need multi-rail, self-hosted, embeddable middleware with the broadest feature set, use toll-booth.

We built toll-booth because we needed all of these payment rails in one place, with no accounts, no KYC, and no third-party dependencies. If that matches your requirements, we think you will like it.
