// src/index.ts
export { tollBooth } from './middleware.js'
export type { EventHandler } from './middleware.js'
export { mintMacaroon, verifyMacaroon, parseCaveats } from './macaroon.js'
export { CreditMeter } from './meter.js'
export { FreeTier } from './free-tier.js'

export type {
  LightningBackend,
  Invoice,
  InvoiceStatus,
  PricingTable,
  BoothConfig,
  PaymentEvent,
  RequestEvent,
} from './types.js'
