// src/backends/lnd.integration.test.ts
//
// Integration test against a real LND instance.
// Skipped by default — run with LND_REST_URL and LND_MACAROON env vars:
//
//   LND_REST_URL=https://localhost:8080 LND_MACAROON=0201036c6e64... npx vitest run src/backends/lnd.integration.test.ts
//
import { describe, it, expect } from 'vitest'
import { lndBackend } from './lnd.js'
import { backendConformanceTests } from './conformance.js'

const url = process.env.LND_REST_URL
const macaroon = process.env.LND_MACAROON
const hasCredentials = !!url && !!macaroon

describe.skipIf(!hasCredentials)('lnd integration', () => {
  const backend = hasCredentials
    ? lndBackend({ url, macaroon })
    : null as unknown as ReturnType<typeof lndBackend>

  backendConformanceTests('lnd', () => backend)

  it('creates an invoice and checks its status', async () => {
    const invoice = await backend.createInvoice(1, 'integration test')

    expect(invoice.bolt11).toMatch(/^lnbc/)
    expect(invoice.paymentHash).toMatch(/^[0-9a-f]{64}$/)

    const status = await backend.checkInvoice(invoice.paymentHash)
    expect(status.paid).toBe(false)
    expect(status.preimage).toBeUndefined()
  })
})
