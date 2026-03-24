# Let AI Agents Pay for your API

Give any MCP-capable AI agent - Claude, GPT, Cursor, Windsurf - the ability to discover your API, pay for it with Lightning, and consume it. No API keys, no OAuth, no billing portal. The agent handles everything autonomously.

## What you'll build

An API that AI agents can discover, pay for, and consume without human intervention. The server gates your API behind Lightning payments; the client gives the agent a wallet and the ability to use it.

## The stack

| Component | Role | Side |
|-----------|------|------|
| [toll-booth](https://github.com/forgesworn/toll-booth) | HTTP 402 middleware - gates your API behind Lightning payments | Server |
| [402-mcp](https://github.com/forgesworn/402-mcp) | MCP server - gives AI agents L402 payment ability | Client |
| Any MCP host | Claude Desktop, Cursor, Windsurf, or any MCP-capable AI | Client |

## Architecture

```
┌────────────┐     ┌──────────┐     ┌────────────┐     ┌──────────┐
│  AI Agent  │────>│ 402-mcp  │────>│ toll-booth  │────>│ Your API │
│ (Claude,   │<────│ (wallet  │<────│ (payment   │<────│          │
│  Cursor)   │     │  + L402) │     │  gateway)  │     │          │
└────────────┘     └──────────┘     └────────────┘     └──────────┘
```

The agent never touches money directly. 402-mcp manages the wallet, intercepts 402 responses, pays invoices, and retries requests with the L402 credential - all transparently.

## Server side: gate your API

### Option A: quick demo (no Lightning node)

```bash
npx @forgesworn/toll-booth demo
```

This spins up a fully working L402-gated joke API on localhost with a mock Lightning backend, in-memory storage, and zero configuration. Perfect for testing the agent flow.

### Option B: your own API

```bash
npm install @forgesworn/toll-booth
```

```typescript
import express from 'express'
import { Booth } from '@forgesworn/toll-booth'
import { phoenixdBackend } from '@forgesworn/toll-booth/backends/phoenixd'

const app = express()
const booth = new Booth({
  adapter: 'express',
  backend: phoenixdBackend({
    url: 'http://localhost:9740',
    password: process.env.PHOENIXD_PASSWORD!,
  }),
  pricing: { '/api': 10 },           // 10 sats per request
  upstream: 'http://localhost:8080',  // your existing API
})

app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as express.RequestHandler)
app.post('/create-invoice', booth.createInvoiceHandler as express.RequestHandler)
app.use('/', booth.middleware as express.RequestHandler)

app.listen(3000, () => console.log('Gated API running on :3000'))
```

That's it. Any request to `/api` without a valid L402 credential now returns a 402 with a Lightning invoice.

## Client side: give the agent a wallet

### Claude Desktop

Add 402-mcp to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "402-mcp": {
      "command": "npx",
      "args": ["402-mcp"],
      "env": {
        "NWC_URL": "nostr+walletconnect://..."
      }
    }
  }
}
```

### Cursor

Add 402-mcp in your MCP settings (Settings > MCP Servers > Add):

- **Name:** `402-mcp`
- **Command:** `npx 402-mcp`
- **Environment:** `NWC_URL=nostr+walletconnect://...`

### Any MCP host

The command is always the same:

```bash
npx 402-mcp
```

402-mcp needs a wallet to pay invoices. Set the `NWC_URL` environment variable to a [Nostr Wallet Connect](https://nwc.dev) connection string from any compatible wallet (Alby Hub, Phoenix, Mutiny, Umbrel, etc.).

## The flow, explained

Here's what happens when an agent calls your gated API:

```
1. Agent calls GET /api/resource
   ↓
2. toll-booth checks credentials - none found
   ↓
3. toll-booth returns 402 Payment Required
   Headers: WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
   ↓
4. 402-mcp intercepts the 402 response
   ↓
5. 402-mcp pays the Lightning invoice from its configured wallet
   ↓
6. 402-mcp retries the request with:
   Authorization: L402 <macaroon>:<preimage>
   ↓
7. toll-booth verifies the macaroon and preimage
   ↓
8. toll-booth credits the account and proxies to your API
   ↓
9. Agent receives the response - it never knew about the payment
```

The entire payment cycle - challenge, payment, retry - happens in seconds. The agent sees a seamless API call. The credit system means subsequent requests are instant; the agent only pays again when the balance runs out.

## Why this beats API keys

| | API keys | L402 with toll-booth |
|---|---|---|
| **Setup** | Sign up, verify email, generate key, store securely | Point 402-mcp at a wallet |
| **Per-service overhead** | New key per service, manage rotation | One wallet pays any L402 API |
| **Agent autonomy** | Agent needs pre-provisioned keys for each service | Agent discovers and pays on the fly |
| **Billing** | Monthly invoices, overages, disputes | Pay-per-request, instant settlement |
| **Privacy** | Account with PII required | No account, no identity, no PII |

The fundamental difference: API keys require a human to provision access in advance. L402 lets the agent provision its own access at the moment it needs it.

## Try it end to end

1. Start the demo server:
   ```bash
   npx @forgesworn/toll-booth demo
   ```

2. Configure 402-mcp in your MCP host (see above).

3. Ask the agent: *"Fetch me a joke from http://localhost:3000/api/joke"*

4. Watch the agent hit the 402 paywall, pay the invoice, and return the joke - all without you lifting a finger.

## What's next

Once your API is gated and agents can pay for it, you can make it discoverable:

### Nostr service announcements

Use [toll-booth-announce](https://github.com/forgesworn/toll-booth-announce) to broadcast your API's existence on Nostr relays. Agents using 402-mcp can discover your service automatically - no directory listing or registration required.

```bash
npx toll-booth-announce
```

toll-booth-announce reads your toll-booth configuration and publishes a [NIP-402](https://github.com/nostr-protocol/nips/blob/master/402.md) kind 31402 event describing your API's endpoints, pricing, and capabilities.

### NIP-90 Data Vending Machines

Use [toll-booth-dvm](https://github.com/forgesworn/toll-booth-dvm) to expose your API as a Nostr Data Vending Machine. Agents can submit jobs via Nostr, pay via Lightning, and receive results - all through the Nostr protocol.

### Live directory

Browse all announced L402 services at [402.pub](https://402.pub) - a live directory that streams kind 31402 events from Nostr relays. If you announce your API, it appears there automatically.

### The vision

The end state is an open marketplace where AI agents autonomously discover APIs on Nostr, evaluate pricing, pay with Lightning, and consume services - all without human coordination. toll-booth is the server side. 402-mcp is the client side. Nostr is the discovery layer. Lightning is the settlement layer. No platforms. No gatekeepers. No accounts.
