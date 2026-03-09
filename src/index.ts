// src/index.ts
export { tollBooth } from './middleware.js'
export type { EventHandler, TollBoothMiddleware } from './middleware.js'
export { invoiceStatus } from './invoice-status.js'
export { createInvoiceHandler } from './create-invoice.js'
export { Booth } from './booth.js'
export { mintMacaroon, verifyMacaroon, parseCaveats } from './macaroon.js'
export { CreditMeter } from './meter.js'
export { InvoiceStore } from './invoice-store.js'
export type { StoredInvoice } from './invoice-store.js'
export { FreeTier } from './free-tier.js'
export { renderPaymentPage, renderErrorPage } from './payment-page.js'
export { StatsCollector } from './stats.js'
export type { BoothStats } from './stats.js'

export type {
  LightningBackend,
  Invoice,
  InvoiceStatus,
  PricingTable,
  BoothConfig,
  CreditTier,
  PaymentEvent,
  RequestEvent,
  ChallengeEvent,
} from './types.js'
