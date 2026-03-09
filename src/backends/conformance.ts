import { describe, it, expect } from 'vitest'
import type { LightningBackend } from '../types.js'

/**
 * Shared conformance tests for any LightningBackend implementation.
 *
 * Call from integration tests that have a real Lightning node available.
 * Unit tests should NOT use this — they test HTTP request shaping instead.
 */
export function backendConformanceTests(
  name: string,
  backend: () => LightningBackend,
) {
  describe(`${name} conformance`, () => {
    it('creates an invoice with valid bolt11 and 64-char hex payment hash', async () => {
      const invoice = await backend().createInvoice(1, 'conformance test')
      expect(invoice.bolt11).toMatch(/^lnbc/)
      expect(invoice.paymentHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('returns paid=false for a freshly created invoice', async () => {
      const invoice = await backend().createInvoice(1, 'conformance unpaid')
      const status = await backend().checkInvoice(invoice.paymentHash)
      expect(status.paid).toBe(false)
      expect(status.preimage).toBeUndefined()
    })

    it('returns paid=false for a non-existent payment hash', async () => {
      const fakeHash = '0'.repeat(64)
      const status = await backend().checkInvoice(fakeHash)
      expect(status.paid).toBe(false)
    })
  })
}
