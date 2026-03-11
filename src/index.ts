// src/index.ts

// Booth class (main API)
export { Booth } from './booth.js'
export type { AdapterType, BoothOptions } from './booth.js'

// Core engine (power users)
export { createTollBooth } from './core/toll-booth.js'
export type { TollBoothEngine } from './core/toll-booth.js'
export type { TollBoothRequest, TollBoothResult, TollBoothCoreConfig } from './core/types.js'

// Core handlers
export { handleCreateInvoice } from './core/create-invoice.js'
export type { CreateInvoiceDeps } from './core/create-invoice.js'
export { handleInvoiceStatus, renderInvoiceStatusHtml } from './core/invoice-status.js'
export type { InvoiceStatusDeps } from './core/invoice-status.js'

// Storage
export type { StorageBackend, StoredInvoice, DebitResult } from './storage/interface.js'
export { sqliteStorage } from './storage/sqlite.js'
export type { SqliteStorageConfig } from './storage/sqlite.js'
export { memoryStorage } from './storage/memory.js'

// Adapters
export { createHonoMiddleware, createHonoInvoiceStatusHandler, createHonoCreateInvoiceHandler } from './adapters/hono.js'
export { createExpressMiddleware, createExpressInvoiceStatusHandler, createExpressCreateInvoiceHandler } from './adapters/express.js'
export type { ExpressMiddlewareConfig } from './adapters/express.js'
export { createWebStandardMiddleware, createWebStandardInvoiceStatusHandler, createWebStandardCreateInvoiceHandler } from './adapters/web-standard.js'
export type { WebStandardHandler, WebStandardMiddlewareConfig } from './adapters/web-standard.js'

// Utilities
export { mintMacaroon, verifyMacaroon, parseCaveats } from './macaroon.js'
export { FreeTier } from './free-tier.js'
export { StatsCollector } from './stats.js'
export { renderPaymentPage, renderErrorPage } from './payment-page.js'

// Types
export type {
  LightningBackend, Invoice, InvoiceStatus, PricingTable, BoothConfig,
  CreditTier, PaymentEvent, RequestEvent, ChallengeEvent, EventHandler,
} from './types.js'
export type { BoothStats } from './stats.js'
