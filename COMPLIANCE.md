# Compliance Posture

toll-booth is **middleware** — a software library that operators deploy in front of their own APIs. It is not a financial service, exchange, custodian, or money transmitter.

## Operator Responsibility

**Operators deploying toll-booth are solely responsible for their own regulatory compliance**, including but not limited to:

- Money transmitter licensing (US FinCEN MSB, state MTLs)
- Crypto-asset service provider authorisation (EU MiCA CASP)
- Anti-money laundering programme (KYC/AML)
- Data protection (GDPR, UK GDPR, CCPA)
- Tax reporting obligations (DAC8, Form 1099-DA, OECD CARF)
- Sanctions screening (OFAC, EU, UN sanctions lists)

toll-booth provides building blocks (geo-fencing, audit events, data minimisation) but does not constitute a compliance programme.

## Data Handling

### Personal Data

toll-booth collects **minimal data** by design:

| Data | Stored? | How |
|------|---------|-----|
| Client IP address | Hashed only | SHA-256 with daily-rotating salt. Raw IP never persisted. |
| Payment hashes | Yes | Pseudonymous Lightning identifiers. Not PII. |
| Bearer tokens | Session lifetime only | Server-generated opaque values. Deleted on session close. |
| Return invoices | Session lifetime only | BOLT11 routing info. No identity data. |

No user accounts, emails, names, or identity data are collected.

### Data Retention

- **Invoices:** Pruned hourly, default 24-hour retention (`invoiceMaxAgeMs`)
- **Sessions:** Pruned hourly after close, same retention period
- **Settlement markers:** Retained permanently (replay prevention — cryptographic necessity)
- **Free-tier IP hashes:** In-memory only, reset daily, capped at 100,000 entries

### GDPR Assessment

For typical deployments where toll-booth processes only hashed IPs and Lightning payment hashes, a full DPIA is unlikely to be required. However, operators who combine toll-booth with additional user data collection should conduct their own assessment.

## Session Intent — Custody Considerations

The session intent introduces **temporary custody**: the server holds a Lightning deposit and refunds unspent balance on close. Compliance guardrails are built in:

| Guardrail | Config | Default |
|-----------|--------|---------|
| Maximum session duration | `maxSessionDurationMs` | 24 hours |
| Maximum deposit amount | `maxDepositSats` | 100,000 sats |
| Auto-close expired sessions | Automatic (hourly sweep) | Enabled |
| Refund-to-originator only | Enforced in code | Always |

Operators using the session intent should assess whether temporary custody triggers licensing requirements in their jurisdiction. For small-value, short-duration API metering, enforcement risk is low in most jurisdictions, but this is not legal advice.

## Geo-Fencing

toll-booth includes an OFAC sanctions country list (`OFAC_SANCTIONED`) as a starting point:

- Cuba (CU), Iran (IR), North Korea (KP), Syria (SY), Russia (RU)

**This is a point-in-time snapshot. Operators must:**
- Verify against the current OFAC SDN list
- Add jurisdictions required by their applicable sanctions regime (e.g. UK OFSI, EU)
- Configure via `blockedCountries` in BoothConfig

## Audit Events

toll-booth emits structured events via the `EventHandler` interface:

- `onPayment` — payment received (hash, amount, rail, timestamp)
- `onRequest` — authenticated request (endpoint, cost, balance, latency)
- `onChallenge` — 402 challenge issued (endpoint, amount)
- `onSessionEvent` — session lifecycle (open, close, expire, topup, deduct)

Operators should persist these events according to their retention requirements (typically 5 years for AML-regulated entities).

## Disclaimer

This document describes toll-booth's technical compliance features, not legal compliance. It does not constitute legal advice. Operators should consult qualified legal counsel for their specific regulatory obligations.
