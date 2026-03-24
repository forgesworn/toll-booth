# Architecture

The toll-booth ecosystem has three layers: a payment middleware, domain-specific proxies, and an agent client. Payment rails are pluggable — the layers above don't care how money moves.

## Ecosystem overview

```mermaid
graph TB
    subgraph "AI Agents"
        A1[Claude / GPT / any MCP-capable model]
    end

    subgraph "Client Layer"
        L402_MCP["402-mcp<br/><i>MCP server — gives agents economic agency</i>"]
    end

    subgraph "Product Layer"
        TT["satgate<br/><i>AI inference proxy — pay-per-token</i>"]
        FUTURE["your-toll<br/><i>your domain-specific proxy</i>"]
    end

    subgraph "Middleware Layer"
        TB["toll-booth<br/><i>HTTP 402 payment gating</i>"]
    end

    subgraph "Payment Rails"
        LN[Lightning<br/>Phoenixd / LND / CLN / LNbits / NWC]
        CASHU[Cashu<br/>ecash tokens]
        NWC[NWC<br/>Nostr Wallet Connect]
        X402["x402<br/>USDC stablecoins<br/><i>(coming soon)</i>"]
    end

    subgraph "Upstream Services"
        OLLAMA[Ollama]
        VLLM[vLLM]
        ANY_API[Any HTTP API]
    end

    A1 --> L402_MCP
    L402_MCP -->|"discover / pay / consume"| TT
    L402_MCP -->|"discover / pay / consume"| FUTURE
    TT --> TB
    FUTURE --> TB
    TB --> LN
    TB --> CASHU
    TB --> NWC
    TB -.-> X402
    TT -->|"proxy inference"| OLLAMA
    TT -->|"proxy inference"| VLLM
    FUTURE -->|"proxy requests"| ANY_API
```

## Payment flow

The HTTP 402 challenge-response cycle. Same flow regardless of payment rail.

```mermaid
sequenceDiagram
    participant Client
    participant Toll as toll-booth
    participant Rail as Payment Rail
    participant API as Upstream API

    Client->>Toll: GET /api/resource
    Toll->>Toll: Check free tier / existing credits

    alt Has credits or free tier
        Toll->>API: Proxy request
        API-->>Toll: Response
        Toll-->>Client: 200 OK
    else Payment required
        Toll-->>Client: 402 + payment challenge
        Client->>Rail: Pay (Lightning / Cashu / NWC / x402)
        Rail-->>Client: Proof of payment
        Client->>Toll: Retry with credential
        Toll->>Toll: Verify payment, credit account
        Toll->>API: Proxy request
        API-->>Toll: Response
        Toll-->>Client: 200 OK + X-Credit-Balance
    end
```

## Agent-pays-agent flow

An AI agent autonomously discovers, pays for, and consumes an API — no human in the loop.

```mermaid
sequenceDiagram
    participant Agent as AI Agent
    participant MCP as 402-mcp
    participant TT as satgate
    participant TB as toll-booth
    participant LLM as Upstream LLM

    Agent->>MCP: l402_discover("https://inference.example.com")
    MCP->>TT: GET /.well-known/l402
    TT-->>MCP: Pricing, models, payment methods
    MCP-->>Agent: "3 models, 1-5 sats/1k tokens, accepts Lightning + Cashu"

    Agent->>MCP: l402_fetch("/v1/chat/completions", {...})
    MCP->>TT: POST /v1/chat/completions
    TT->>TB: Payment check
    TB-->>TT: 402 challenge
    TT-->>MCP: 402 + invoice

    MCP->>MCP: Auto-pay from wallet (within budget)
    MCP->>TT: Retry with L402 credential
    TT->>TB: Verify credential
    TB-->>TT: Authorised, debit credits
    TT->>LLM: Proxy inference request
    LLM-->>TT: Streamed response
    TT->>TT: Count tokens, reconcile cost
    TT-->>MCP: 200 + response + X-Credit-Balance
    MCP-->>Agent: Inference result
```

## Payment rail abstraction

toll-booth treats payment rails as pluggable backends. Each implements a simple interface — the middleware layer doesn't know or care which rail settled the payment.

```mermaid
graph LR
    subgraph "toll-booth core"
        GATE[Gating & Auth]
        CREDIT[Credit Accounting]
        FREE[Free Tier]
        PROXY[Upstream Proxy]
    end

    subgraph "LightningBackend interface"
        direction TB
        CI["createInvoice()"]
        CHK["checkInvoice()"]
    end

    subgraph "Backends"
        direction TB
        PHX[phoenixdBackend]
        LND_B[lndBackend]
        CLN_B[clnBackend]
        LNBITS[lnbitsBackend]
        NWC_B[nwcBackend]
    end

    subgraph "Alternative Rails"
        direction TB
        CASHU_R["redeemCashu()"]
        NWC_R["nwcPayInvoice()"]
        X402_R["x402Backend()<br/><i>(planned)</i>"]
    end

    GATE --> CI
    GATE --> CASHU_R
    GATE --> NWC_R
    GATE -.-> X402_R
    CI --> PHX
    CI --> LND_B
    CI --> CLN_B
    CI --> LNBITS
    CI --> ALBY
```

## satgate: inference-specific layer

satgate adds AI-specific concerns on top of toll-booth's payment gating.

```mermaid
graph TB
    subgraph "satgate"
        CLI["CLI<br/>auto-detect models, startup config"]
        ROUTER["Router<br/>/v1/chat/completions<br/>/v1/completions<br/>/v1/embeddings"]
        PRICING["Model Pricing<br/>per-model rates, defaults, fuzzy matching"]
        TOKENS["Token Counter<br/>buffered / SSE / fallback"]
        CAP["Capacity Manager<br/>concurrent request slots"]
        RECON["Reconciliation<br/>estimated charge vs actual cost"]
        DISC["Discoverability<br/>/.well-known/l402 | /llms.txt | /openapi.json"]
    end

    subgraph "toll-booth"
        TB_MW["Payment Middleware"]
    end

    subgraph "Upstream"
        LLM_UP["Ollama / vLLM / llama.cpp"]
    end

    CLI --> ROUTER
    ROUTER --> TB_MW
    TB_MW --> ROUTER
    ROUTER --> PRICING
    ROUTER --> CAP
    ROUTER --> LLM_UP
    LLM_UP --> TOKENS
    TOKENS --> RECON
    RECON --> TB_MW
    DISC --> PRICING
```

## The stack at a glance

| Layer | Project | What it does | What it doesn't do |
|-------|---------|-------------|-------------------|
| **Client** | [402-mcp](https://github.com/forgesworn/402-mcp) | Discovers, pays, consumes L402 APIs | Doesn't gate or price anything |
| **Product** | [satgate](https://github.com/TheCryptoDonkey/satgate) | Token counting, model pricing, capacity, streaming | Doesn't handle payments directly |
| **Middleware** | [toll-booth](https://github.com/forgesworn/toll-booth) | Payment gating, credit accounting, free tiers | Doesn't know about tokens or models |
| **Rails** | Lightning / Cashu / NWC / x402 | Moves money | Doesn't know about HTTP or APIs |

Each layer does one thing. The boundaries are sharp. Swap any layer without touching the others.
