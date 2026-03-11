# X Thread — toll-booth launch

---

**1/ Hook**

Machines will pay machines. No accounts. No API keys. No middlemen.

HTTP 402 was reserved in 1999. Lightning + Cashu finally make it real.

I built the middleware. It's called toll-booth.

npm install toll-booth

---

**2/ The problem**

Every API on the web assumes you're human: sign up, get a key, add a card.

AI agents can't fill in forms. Autonomous services can't wait 30 days for an invoice.

L402 fixes this: the server sends a price, the client pays, the request proceeds. The payment IS the auth.

---

**3/ Lightning — 5 backends, zero lock-in**

Phoenixd. LND. Core Lightning. LNbits. Alby.

Use what you already run. toll-booth doesn't care.

```typescript
import { phoenixdBackend } from 'toll-booth/backends/phoenixd'
import { lndBackend } from 'toll-booth/backends/lnd'
import { clnBackend } from 'toll-booth/backends/cln'
```

---

**4/ Cashu — no Lightning node required**

This changes things.

Cashu ecash tokens. No node. No channels. No liquidity management.

A Cloudflare Worker can gate an API behind payments with zero Lightning infrastructure. Serverless micropayments are real.

---

**5/ NWC — wallet-native payments over Nostr**

Nostr Wallet Connect lets clients pay from any NWC wallet. Same relay infra they already use for social.

Three payment rails. One middleware. The client picks how to pay. The API doesn't care.

---

**6/ Running in production**

Not vapourware. toll-booth gates a Valhalla routing engine at routing.trotters.cc right now.

Real Lightning invoices. Real payments. Real map queries.

Free tier for discovery. Volume discounts for commitment. Self-service payment page with QR codes.

---

**7/ CTA**

The web should work like a vending machine. See the price. Pay. Get the thing.

npm install toll-booth
GitHub: github.com/TheCryptoDonkey/toll-booth

Express, Deno, Bun, Cloudflare Workers. MIT licence.

Zap if useful: thedonkey@strike.me
