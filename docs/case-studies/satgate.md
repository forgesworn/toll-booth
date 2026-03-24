# satgate: Pay-per-Token AI Inference with toll-booth

## The problem

You run a local AI inference endpoint - Ollama, vLLM, llama.cpp - and you want to monetise it. Traditional approaches require user accounts, a billing system, usage tracking, payment processing, and a way to handle disputes. That is a lot of infrastructure for what should be a simple transaction: someone sends tokens to your model, you send tokens back, they pay for what they used.

Flat-rate pricing does not work either. A 20-token completion and a 4,000-token completion cost wildly different amounts to serve. Charging the same for both means you either overcharge small requests or subsidise large ones.

## The solution

[satgate](https://github.com/TheCryptoDonkey/satgate) is a reverse proxy that sits in front of any OpenAI-compatible inference endpoint. It uses toll-booth for all payment infrastructure and adds token counting, model-specific pricing, and streaming reconciliation on top. The entire product is roughly 400 lines of application logic; everything else - payment gating, credit accounting, free tiers, macaroon authentication, persistence - is toll-booth.

One command turns your local model into a paid API. No accounts. No sign-up. No billing dashboard.

## Architecture

```
Client --> satgate --> toll-booth middleware --> Ollama / vLLM / llama.cpp
                            |
                       Lightning / Cashu / x402
```

satgate is an OpenAI-compatible API server. Clients can point any OpenAI SDK or library at it and get inference - provided they pay. The payment flow is invisible to the upstream model; it just receives ordinary inference requests.

## What satgate adds on top of toll-booth

These are the AI-specific concerns that justify satgate as a separate layer:

- **Per-token metering** - counts prompt and completion tokens from the upstream response, charging based on actual usage rather than flat rates
- **Model-specific pricing** - different sats-per-token rates for different models (a 70B parameter model costs more to run than a 7B one)
- **Streaming reconciliation** - for SSE streaming responses, satgate counts tokens in real time and reconciles the estimated charge against the actual cost when the stream completes
- **Capacity management** - limits concurrent inference requests to prevent overloading the upstream model server
- **Cost transparency** - `X-Tokens-Used` and `X-Cost-Sats` response headers so clients know exactly what they paid for
- **Discoverability** - serves `/.well-known/l402`, `/llms.txt`, and `/openapi.json` so AI agents and crawlers can discover pricing, available models, and payment methods automatically

## What toll-booth handles

satgate does not contain a single line of payment code. All of this is delegated to toll-booth:

- **L402 payment flow** - HTTP 402 challenges, invoice creation, macaroon issuance, credential verification
- **Credit ledger** - pre-paid balance tracking with atomic debit-on-request
- **Volume discount tiers** - buy 10,000 sats of credit, get 11,100 credits
- **Free tier** - configurable daily allowance per IP (hashed; no PII stored)
- **Multiple payment rails** - Lightning (five backends), Cashu ecash, xcashu (NUT-24), x402 stablecoins, IETF Payment, NWC - simultaneously
- **Macaroon authentication** - cryptographic bearer credentials with caveats
- **SQLite persistence** - WAL mode, automatic invoice expiry pruning
- **Self-service payment page** - QR codes, tier selector, wallet adapter buttons

## The layering in practice

The separation is clean. satgate owns the question "how many tokens did this request use and what should it cost?" toll-booth owns the question "has this client paid enough to make this request?" Neither layer reaches into the other's concerns.

When an AI agent calls satgate via [402-mcp](https://github.com/forgesworn/402-mcp), the full stack looks like this:

```
AI Agent --> 402-mcp --> satgate --> toll-booth --> Lightning / Cashu
                                        |
                                   Ollama / vLLM
```

The agent discovers the API, receives a 402 challenge, pays the invoice from its wallet, retries with credentials, and gets inference - all without human intervention. Four layers, each doing one thing, each replaceable independently.

## Key takeaway

satgate is roughly 400 lines of product logic on top of toll-booth. That is what "monetise any API with one line of code" looks like in practice. The payment infrastructure - gating, credits, free tiers, multiple payment rails, persistence, authentication - is not something you need to build. It is something you import.

If you are building a paid API, you probably do not need to write payment code at all.

## Links

- **satgate:** [github.com/TheCryptoDonkey/satgate](https://github.com/TheCryptoDonkey/satgate)
- **toll-booth:** [github.com/forgesworn/toll-booth](https://github.com/forgesworn/toll-booth)
- **402-mcp:** [github.com/forgesworn/402-mcp](https://github.com/forgesworn/402-mcp)
- **Live:** [satgate.trotters.dev](https://satgate.trotters.dev)
