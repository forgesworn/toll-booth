# Mission

**toll-booth exists to make any API on the internet payable in seconds, by anyone or anything, without accounts, API keys, or identity.**

The web's payment layer was built for humans. Sign-up forms, credit cards, billing cycles, API key management — none of it works for machines. HTTP reserved status code 402 in 1999. The payment rails finally caught up.

toll-booth turns any HTTP API into a vending machine. One middleware. Multiple payment rails - Lightning, Cashu ecash, x402 stablecoins, IETF Payment, Nostr Wallet Connect. The API operator picks which to accept. The client picks which to use. Neither needs permission from the other.

toll-booth is the foundation of a stack for machine-to-machine commerce. [satgate](https://github.com/TheCryptoDonkey/satgate) builds on it to monetise AI inference. [402-mcp](https://github.com/forgesworn/402-mcp) gives AI agents the ability to discover and pay for toll-booth-protected APIs autonomously. Together, they close the loop: any API can charge, any agent can pay.

We believe:

- **Access should follow payment, not identity.** No accounts. No OAuth. No PII exchanged. Pay and proceed.
- **Payment pluralism beats vendor lock-in.** Five Lightning backends, Cashu-only mode, NWC — use what you already run.
- **The protocol is the product.** L402 is an open standard. toll-booth is an implementation. If something better comes along, the protocol survives.
- **Machines deserve economic agency.** AI agents, autonomous services, and IoT devices should be able to discover, pay for, and consume APIs without human intervention.
- **Privacy by design.** No personal data collected or stored. IP addresses are one-way hashed before any processing. Operators run their own infrastructure, receive their own payments.
- **Simplicity scales.** One npm install. Ten lines of code. Any JavaScript runtime. If it's harder than that, we failed.
