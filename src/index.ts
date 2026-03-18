// src/index.ts

// Booth class (main API)
export { Booth } from './booth.js'
export type { AdapterType, BoothOptions } from './booth.js'

// Core engine (power users)
export { createTollBooth } from './core/toll-booth.js'
export type { TollBoothEngine } from './core/toll-booth.js'
export type { TollBoothRequest, TollBoothResult, TollBoothCoreConfig, ReconcileResult } from './core/types.js'

// Core handlers
export { handleCreateInvoice } from './core/create-invoice.js'
export type { CreateInvoiceDeps } from './core/create-invoice.js'
export { handleInvoiceStatus, renderInvoiceStatusHtml } from './core/invoice-status.js'
export type { InvoiceStatusDeps } from './core/invoice-status.js'
export { handleNwcPay } from './core/nwc-pay.js'
export type { NwcPayDeps } from './core/nwc-pay.js'
export { handleCashuRedeem, REDEEM_LEASE_MS } from './core/cashu-redeem.js'
export type { CashuRedeemDeps } from './core/cashu-redeem.js'

// Storage
export type { StorageBackend, StoredInvoice, DebitResult } from './storage/interface.js'
export { sqliteStorage } from './storage/sqlite.js'
export type { SqliteStorageConfig } from './storage/sqlite.js'
export { memoryStorage } from './storage/memory.js'

// Adapters
export { createExpressMiddleware, createExpressInvoiceStatusHandler, createExpressCreateInvoiceHandler, createExpressNwcHandler, createExpressCashuHandler } from './adapters/express.js'
export type { ExpressMiddlewareConfig } from './adapters/express.js'
export { createWebStandardMiddleware, createWebStandardInvoiceStatusHandler, createWebStandardCreateInvoiceHandler, createWebStandardNwcHandler, createWebStandardCashuHandler } from './adapters/web-standard.js'
export type { WebStandardHandler, WebStandardMiddlewareConfig } from './adapters/web-standard.js'
// Hono adapter types (implementation at @forgesworn/toll-booth/hono)
export type { HonoTollBoothConfig, HonoTollBooth, PaymentAppConfig, TollBoothEnv } from './adapters/hono.js'

// Payment rails
export type { PaymentRail, PriceInfo, PricingEntry, TieredPricing, ChallengeFragment, RailVerifyResult, SettleResult, Currency } from './core/payment-rail.js'
export { normalisePricing, normalisePricingTable, isTieredPricing } from './core/payment-rail.js'
export { createL402Rail } from './core/l402-rail.js'
export type { L402RailConfig } from './core/l402-rail.js'
export { createX402Rail } from './core/x402-rail.js'
export type { X402RailConfig, X402Facilitator, X402Payment, X402VerifyResult, X402ChallengeWire, X402PaymentWire, X402PaymentRequirements } from './core/x402-types.js'
export { DEFAULT_USDC_ASSETS, X402_VERSION } from './core/x402-types.js'
export { createXCashuRail } from './core/xcashu-rail.js'
export type { XCashuConfig } from './types.js'
export { meltToLightning } from './core/melt-to-lightning.js'
export type { MeltResult } from './core/melt-to-lightning.js'

// Utilities
export { mintMacaroon, verifyMacaroon, parseCaveats } from './macaroon.js'
export type { VerifyContext, VerifyResult } from './macaroon.js'
export { FreeTier, CreditFreeTier } from './free-tier.js'
export type { IFreeTier } from './free-tier.js'
export { StatsCollector } from './stats.js'
export { renderPaymentPage, renderErrorPage } from './payment-page.js'

// Geo-fencing
export { OFAC_SANCTIONED, isBlockedCountry } from './geo-fence.js'

// Backends (re-exported for convenience — prefer subpath imports for tree-shaking)
export { phoenixdBackend } from './backends/phoenixd.js'
export type { PhoenixdConfig } from './backends/phoenixd.js'
export { lndBackend } from './backends/lnd.js'
export type { LndConfig } from './backends/lnd.js'
export { clnBackend } from './backends/cln.js'
export type { ClnConfig } from './backends/cln.js'
export { lnbitsBackend } from './backends/lnbits.js'
export type { LNbitsConfig } from './backends/lnbits.js'
export { nwcBackend } from './backends/nwc.js'
export type { NwcConfig } from './backends/nwc.js'

// Types
export type {
  LightningBackend, Invoice, InvoiceStatus, PricingTable, BoothConfig,
  CreditTier, PaymentEvent, RequestEvent, ChallengeEvent, EventHandler,
} from './types.js'
export type { BoothStats } from './stats.js'
