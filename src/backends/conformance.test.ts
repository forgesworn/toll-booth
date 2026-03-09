import { backendConformanceTests } from './conformance.js'
import type { LightningBackend } from '../types.js'

const mockBackend = (): LightningBackend => ({
  async createInvoice(amountSats, memo) {
    return {
      bolt11: 'lnbc10n1ptest',
      paymentHash: 'a'.repeat(64),
    }
  },
  async checkInvoice(paymentHash) {
    return { paid: false }
  },
})

backendConformanceTests('mock', mockBackend)
