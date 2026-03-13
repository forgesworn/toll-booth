// src/storage/sqlite.ts
import { timingSafeEqual } from 'node:crypto'
import Database from 'better-sqlite3'
import type { Currency } from '../core/payment-rail.js'
import type { StorageBackend, DebitResult, StoredInvoice, PendingClaim } from './interface.js'

const DEFAULT_LEASE_MS = 30_000

export interface SqliteStorageConfig {
  path?: string
}

export function sqliteStorage(config?: SqliteStorageConfig): StorageBackend {
  const db = new Database(config?.path ?? ':memory:')
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS credits (
      payment_hash TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      balance_sats INTEGER NOT NULL DEFAULT 0,
      balance_usd INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      payment_hash TEXT PRIMARY KEY,
      bolt11 TEXT NOT NULL,
      amount_sats INTEGER NOT NULL,
      macaroon TEXT NOT NULL,
      status_token TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS settlements (
      payment_hash TEXT PRIMARY KEY,
      settlement_secret TEXT,
      settled_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      payment_hash TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
      lease_expires_at TEXT
    )
  `)

  // Migration: add lease_expires_at column if upgrading from older schema
  try {
    db.exec('ALTER TABLE claims ADD COLUMN lease_expires_at TEXT')
  } catch {
    // Column already exists — ignore
  }

  // Migration: add status_token column and backfill older rows.
  try {
    db.exec('ALTER TABLE invoices ADD COLUMN status_token TEXT')
  } catch {
    // Column already exists — ignore
  }
  db.exec(`
    UPDATE invoices
    SET status_token = lower(hex(randomblob(32)))
    WHERE status_token IS NULL OR status_token = ''
  `)

  // Migration: add settlement_secret column to older schemas.
  try {
    db.exec('ALTER TABLE settlements ADD COLUMN settlement_secret TEXT')
  } catch {
    // Column already exists — ignore
  }

  // Migration: add client_ip column to invoices table.
  try {
    db.exec('ALTER TABLE invoices ADD COLUMN client_ip TEXT')
  } catch {
    // Column already exists — ignore
  }

  // Migration: add dual-currency balance columns to credits table.
  try {
    db.exec('ALTER TABLE credits ADD COLUMN balance_sats INTEGER NOT NULL DEFAULT 0')
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec('ALTER TABLE credits ADD COLUMN balance_usd INTEGER NOT NULL DEFAULT 0')
  } catch {
    // Column already exists — ignore
  }
  // Copy legacy balance into balance_sats for existing rows.
  db.exec('UPDATE credits SET balance_sats = balance WHERE balance > 0 AND balance_sats = 0')

  // Per-currency prepared statements for credit operations
  const stmtCreditSat = db.prepare(`
    INSERT INTO credits (payment_hash, balance, balance_sats)
    VALUES (?, ?, ?)
    ON CONFLICT(payment_hash) DO UPDATE SET
      balance = balance + excluded.balance,
      balance_sats = balance_sats + excluded.balance_sats,
      updated_at = datetime('now')
  `)

  const stmtCreditUsd = db.prepare(`
    INSERT INTO credits (payment_hash, balance_usd)
    VALUES (?, ?)
    ON CONFLICT(payment_hash) DO UPDATE SET
      balance_usd = balance_usd + excluded.balance_usd,
      updated_at = datetime('now')
  `)

  const stmtDebitSat = db.prepare(`
    UPDATE credits SET balance = balance - ?, balance_sats = balance_sats - ?, updated_at = datetime('now')
    WHERE payment_hash = ? AND balance_sats >= ?
  `)

  const stmtDebitUsd = db.prepare(`
    UPDATE credits SET balance_usd = balance_usd - ?, updated_at = datetime('now')
    WHERE payment_hash = ? AND balance_usd >= ?
  `)

  const stmtBalanceSat = db.prepare(
    'SELECT balance_sats AS balance FROM credits WHERE payment_hash = ?'
  )

  const stmtBalanceUsd = db.prepare(
    'SELECT balance_usd AS balance FROM credits WHERE payment_hash = ?'
  )

  function debitFor(currency: Currency) { return currency === 'usd' ? stmtDebitUsd : stmtDebitSat }
  function balanceFor(currency: Currency) { return currency === 'usd' ? stmtBalanceUsd : stmtBalanceSat }

  const stmtStoreInvoice = db.prepare(`
    INSERT OR IGNORE INTO invoices (payment_hash, bolt11, amount_sats, macaroon, status_token, client_ip)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const stmtPendingInvoiceCount = db.prepare(`
    SELECT COUNT(*) as count FROM invoices i
    LEFT JOIN settlements s ON i.payment_hash = s.payment_hash
    WHERE i.client_ip = ? AND s.payment_hash IS NULL
  `)

  const stmtGetInvoice = db.prepare(
    'SELECT payment_hash, bolt11, amount_sats, macaroon, created_at FROM invoices WHERE payment_hash = ?'
  )

  const stmtGetInvoiceWithToken = db.prepare(
    `SELECT payment_hash, bolt11, amount_sats, macaroon, status_token, created_at
     FROM invoices
     WHERE payment_hash = ?`
  )

  const stmtSettle = db.prepare(
    'INSERT OR IGNORE INTO settlements (payment_hash, settlement_secret) VALUES (?, ?)'
  )

  const stmtIsSettled = db.prepare(
    'SELECT 1 FROM settlements WHERE payment_hash = ?'
  )

  const stmtGetSettlementSecret = db.prepare(
    'SELECT settlement_secret FROM settlements WHERE payment_hash = ?'
  )

  const stmtClaim = db.prepare(
    'INSERT OR IGNORE INTO claims (payment_hash, token, lease_expires_at) VALUES (?, ?, ?)'
  )

  const stmtPendingClaims = db.prepare(`
    SELECT c.payment_hash, c.token, c.claimed_at
    FROM claims c
    LEFT JOIN settlements s ON c.payment_hash = s.payment_hash
    WHERE s.payment_hash IS NULL
  `)

  const stmtDeleteClaim = db.prepare(
    'DELETE FROM claims WHERE payment_hash = ?'
  )

  const stmtTryAcquireRecoveryLease = db.prepare(`
    UPDATE claims
    SET lease_expires_at = ?
    WHERE payment_hash = ?
      AND (lease_expires_at IS NULL OR datetime(lease_expires_at) <= datetime('now'))
      AND payment_hash NOT IN (SELECT payment_hash FROM settlements)
  `)

  const stmtExtendRecoveryLease = db.prepare(`
    UPDATE claims
    SET lease_expires_at = ?
    WHERE payment_hash = ?
      AND datetime(lease_expires_at) > datetime('now')
      AND payment_hash NOT IN (SELECT payment_hash FROM settlements)
  `)

  const stmtGetClaim = db.prepare(
    'SELECT payment_hash, token, claimed_at FROM claims WHERE payment_hash = ?'
  )

  const stmtPruneInvoices = db.prepare(`
    DELETE FROM invoices
    WHERE datetime(created_at) <= datetime('now', '-' || ? || ' seconds')
      AND payment_hash NOT IN (SELECT payment_hash FROM claims)
  `)

  const stmtPruneZeroCredits = db.prepare(`
    DELETE FROM credits
    WHERE balance_sats <= 0 AND balance_usd <= 0
      AND datetime(updated_at) <= datetime('now', '-' || ? || ' seconds')
  `)

  const stmtPruneSettlements = db.prepare(`
    DELETE FROM settlements
    WHERE datetime(settled_at) <= datetime('now', '-' || ? || ' seconds')
  `)

  const stmtPruneClaims = db.prepare(`
    DELETE FROM claims
    WHERE payment_hash IN (SELECT payment_hash FROM settlements)
      OR datetime(claimed_at) <= datetime('now', '-' || ? || ' seconds')
  `)

  const txnClaimForRedeem = db.transaction((paymentHash: string, token: string, leaseExpiresAt: string) => {
    // Reject if already settled
    if (stmtIsSettled.get(paymentHash)) return false
    // Try to claim (INSERT OR IGNORE — fails silently if already claimed)
    const r = stmtClaim.run(paymentHash, token, leaseExpiresAt)
    return r.changes > 0
  })

  const txnSettleWithCredit = db.transaction((paymentHash: string, amount: number, settlementSecret?: string, currency: Currency = 'sat') => {
    const r = stmtSettle.run(paymentHash, settlementSecret ?? null)
    if (r.changes > 0) {
      if (currency === 'usd') {
        stmtCreditUsd.run(paymentHash, amount)
      } else {
        stmtCreditSat.run(paymentHash, amount, amount)
      }
      stmtDeleteClaim.run(paymentHash)
      return true
    }
    return false
  })

  const txnTryAcquireRecoveryLease = db.transaction((paymentHash: string, leaseExpiresAt: string): PendingClaim | undefined => {
    const r = stmtTryAcquireRecoveryLease.run(leaseExpiresAt, paymentHash)
    if (r.changes === 0) return undefined
    const row = stmtGetClaim.get(paymentHash) as {
      payment_hash: string
      token: string
      claimed_at: string
    } | undefined
    if (!row) return undefined
    return {
      paymentHash: row.payment_hash,
      token: row.token,
      claimedAt: row.claimed_at,
    }
  })

  const stmtAdjustCreditsSat = db.prepare(`
    UPDATE credits SET
      balance_sats = MAX(0, balance_sats + ?),
      balance = MAX(0, balance + ?),
      updated_at = datetime('now')
    WHERE payment_hash = ?
  `)

  const stmtAdjustCreditsUsd = db.prepare(`
    UPDATE credits SET balance_usd = MAX(0, balance_usd + ?), updated_at = datetime('now')
    WHERE payment_hash = ?
  `)

  const txnAdjustCredits = db.transaction((paymentHash: string, delta: number, currency: Currency = 'sat'): number => {
    const stmtBal = balanceFor(currency)
    const row = stmtBal.get(paymentHash) as { balance: number } | undefined
    if (!row) {
      const newBalance = Math.max(0, delta)
      if (currency === 'usd') {
        stmtCreditUsd.run(paymentHash, newBalance)
      } else {
        stmtCreditSat.run(paymentHash, newBalance, newBalance)
      }
      return newBalance
    }
    if (currency === 'usd') {
      stmtAdjustCreditsUsd.run(delta, paymentHash)
    } else {
      stmtAdjustCreditsSat.run(delta, delta, paymentHash)
    }
    const updated = stmtBal.get(paymentHash) as { balance: number }
    return updated.balance
  })

  const txnDebit = db.transaction((paymentHash: string, amount: number, currency: Currency = 'sat'): DebitResult => {
    const stmtBal = balanceFor(currency)
    const row = stmtBal.get(paymentHash) as { balance: number } | undefined
    const current = row?.balance ?? 0
    if (current < amount) {
      return { success: false, remaining: current }
    }
    const stmtDeb = debitFor(currency)
    const result = currency === 'sat'
      ? stmtDeb.run(amount, amount, paymentHash, amount)
      : stmtDeb.run(amount, paymentHash, amount)
    if (result.changes === 0) {
      return { success: false, remaining: current }
    }
    return { success: true, remaining: current - amount }
  })

  return {
    credit(paymentHash: string, amount: number, currency: Currency = 'sat'): void {
      if (amount <= 0) throw new RangeError('credit amount must be positive')
      if (currency === 'usd') {
        stmtCreditUsd.run(paymentHash, amount)
      } else {
        stmtCreditSat.run(paymentHash, amount, amount)
      }
    },

    debit(paymentHash: string, amount: number, currency: Currency = 'sat'): DebitResult {
      return txnDebit(paymentHash, amount, currency)
    },

    adjustCredits(paymentHash: string, delta: number, currency: Currency = 'sat'): number {
      return txnAdjustCredits(paymentHash, delta, currency)
    },

    balance(paymentHash: string, currency: Currency = 'sat'): number {
      const row = balanceFor(currency).get(paymentHash) as { balance: number } | undefined
      return row?.balance ?? 0
    },

    settle(paymentHash: string): boolean {
      const result = stmtSettle.run(paymentHash, null)
      return result.changes > 0
    },

    isSettled(paymentHash: string): boolean {
      return !!stmtIsSettled.get(paymentHash)
    },

    settleWithCredit(paymentHash: string, amount: number, settlementSecret?: string, currency: Currency = 'sat'): boolean {
      return txnSettleWithCredit(paymentHash, amount, settlementSecret, currency)
    },

    getSettlementSecret(paymentHash: string): string | undefined {
      const row = stmtGetSettlementSecret.get(paymentHash) as { settlement_secret: string | null } | undefined
      return row?.settlement_secret ?? undefined
    },

    claimForRedeem(paymentHash: string, token: string, leaseMs?: number): boolean {
      const ms = leaseMs ?? DEFAULT_LEASE_MS
      const leaseExpiresAt = new Date(Date.now() + ms).toISOString()
      return txnClaimForRedeem(paymentHash, token, leaseExpiresAt)
    },

    pendingClaims(): PendingClaim[] {
      const rows = stmtPendingClaims.all() as Array<{
        payment_hash: string
        token: string
        claimed_at: string
      }>
      return rows.map((r) => ({
        paymentHash: r.payment_hash,
        token: r.token,
        claimedAt: r.claimed_at,
      }))
    },

    tryAcquireRecoveryLease(paymentHash: string, leaseMs: number): PendingClaim | undefined {
      const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString()
      return txnTryAcquireRecoveryLease(paymentHash, leaseExpiresAt)
    },

    extendRecoveryLease(paymentHash: string, leaseMs: number): boolean {
      const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString()
      const result = stmtExtendRecoveryLease.run(leaseExpiresAt, paymentHash)
      return result.changes > 0
    },

    storeInvoice(paymentHash: string, bolt11: string, amountSats: number, macaroon: string, statusToken: string, clientIp?: string): void {
      stmtStoreInvoice.run(paymentHash, bolt11, amountSats, macaroon, statusToken, clientIp ?? null)
    },

    pendingInvoiceCount(clientIp: string): number {
      const row = stmtPendingInvoiceCount.get(clientIp) as { count: number }
      return row.count
    },

    getInvoice(paymentHash: string): StoredInvoice | undefined {
      const row = stmtGetInvoice.get(paymentHash) as {
        payment_hash: string
        bolt11: string
        amount_sats: number
        macaroon: string
        created_at: string
      } | undefined
      if (!row) return undefined
      return {
        paymentHash: row.payment_hash,
        bolt11: row.bolt11,
        amountSats: row.amount_sats,
        macaroon: row.macaroon,
        createdAt: row.created_at,
      }
    },

    getInvoiceForStatus(paymentHash: string, statusToken: string): StoredInvoice | undefined {
      const row = stmtGetInvoiceWithToken.get(paymentHash) as {
        payment_hash: string
        bolt11: string
        amount_sats: number
        macaroon: string
        status_token: string
        created_at: string
      } | undefined
      if (!row) return undefined
      // Timing-safe comparison to prevent token enumeration via timing side-channel
      const storedBuf = Buffer.from(row.status_token)
      const providedBuf = Buffer.from(statusToken)
      if (storedBuf.length !== providedBuf.length || !timingSafeEqual(storedBuf, providedBuf)) return undefined
      return {
        paymentHash: row.payment_hash,
        bolt11: row.bolt11,
        amountSats: row.amount_sats,
        macaroon: row.macaroon,
        createdAt: row.created_at,
      }
    },

    pruneExpiredInvoices(maxAgeMs: number): number {
      const maxAgeSecs = Math.floor(maxAgeMs / 1000)
      const result = stmtPruneInvoices.run(maxAgeSecs)
      return result.changes
    },

    pruneStaleRecords(maxAgeMs: number): number {
      const maxAgeSecs = Math.floor(maxAgeMs / 1000)
      let total = 0
      total += stmtPruneZeroCredits.run(maxAgeSecs).changes
      total += stmtPruneSettlements.run(maxAgeSecs).changes
      total += stmtPruneClaims.run(maxAgeSecs).changes
      return total
    },

    close(): void {
      db.close()
    },
  }
}
