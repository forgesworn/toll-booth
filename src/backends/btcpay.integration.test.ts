// src/backends/btcpay.integration.test.ts
//
// Integration test against a real BTCPay Server store with Lightning set up.
// Skipped by default — run with BTCPAY_URL, BTCPAY_STORE_ID and BTCPAY_API_KEY env vars:
//
//   BTCPAY_URL=http://localhost:14142 BTCPAY_STORE_ID=... BTCPAY_API_KEY=... npx vitest run src/backends/btcpay.integration.test.ts
//
import { describe, it, expect } from 'vitest'
import { btcpayBackend } from './btcpay.js'
import { backendConformanceTests } from './conformance.js'

const url = process.env.BTCPAY_URL
const storeId = process.env.BTCPAY_STORE_ID
const apiKey = process.env.BTCPAY_API_KEY
const hasCredentials = !!url && !!storeId && !!apiKey

describe.skipIf(!hasCredentials)('btcpay integration', () => {
  // Safe: only called when credentials are present (skipIf guards execution)
  const backend = hasCredentials
    ? btcpayBackend({ url, storeId, apiKey })
    : null as unknown as ReturnType<typeof btcpayBackend>

  backendConformanceTests('btcpay', () => backend)

  it('creates an invoice and checks its status', async () => {
    const invoice = await backend.createInvoice(1, 'integration test')

    expect(invoice.bolt11).toMatch(/^lnbc/)
    expect(invoice.paymentHash).toMatch(/^[0-9a-f]{64}$/)

    const status = await backend.checkInvoice(invoice.paymentHash)
    expect(status.paid).toBe(false)
    expect(status.preimage).toBeUndefined()
  })
})
