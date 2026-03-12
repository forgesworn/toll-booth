// src/storage/sqlite.ts
import Database from 'better-sqlite3'
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

  const stmtCredit = db.prepare(`
    INSERT INTO credits (payment_hash, balance)
    VALUES (?, ?)
    ON CONFLICT(payment_hash) DO UPDATE SET
      balance = balance + excluded.balance,
      updated_at = datetime('now')
  `)

  const stmtDebit = db.prepare(`
    UPDATE credits SET balance = balance - ?, updated_at = datetime('now')
    WHERE payment_hash = ? AND balance >= ?
  `)

  const stmtBalance = db.prepare(
    'SELECT balance FROM credits WHERE payment_hash = ?'
  )

  const stmtStoreInvoice = db.prepare(`
    INSERT OR IGNORE INTO invoices (payment_hash, bolt11, amount_sats, macaroon, status_token)
    VALUES (?, ?, ?, ?, ?)
  `)

  const stmtGetInvoice = db.prepare(
    'SELECT payment_hash, bolt11, amount_sats, macaroon, created_at FROM invoices WHERE payment_hash = ?'
  )

  const stmtGetInvoiceForStatus = db.prepare(
    `SELECT payment_hash, bolt11, amount_sats, macaroon, created_at
     FROM invoices
     WHERE payment_hash = ? AND status_token = ?`
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
  `)

  const stmtPruneZeroCredits = db.prepare(`
    DELETE FROM credits
    WHERE balance <= 0
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

  const txnSettleWithCredit = db.transaction((paymentHash: string, amount: number, settlementSecret?: string) => {
    const r = stmtSettle.run(paymentHash, settlementSecret ?? null)
    if (r.changes > 0) {
      stmtCredit.run(paymentHash, amount)
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

  const stmtAdjustCredits = db.prepare(`
    UPDATE credits SET balance = MAX(0, balance + ?), updated_at = datetime('now')
    WHERE payment_hash = ?
  `)

  const txnAdjustCredits = db.transaction((paymentHash: string, delta: number): number => {
    const row = stmtBalance.get(paymentHash) as { balance: number } | undefined
    if (!row) {
      const newBalance = Math.max(0, delta)
      stmtCredit.run(paymentHash, newBalance)
      return newBalance
    }
    stmtAdjustCredits.run(delta, paymentHash)
    const updated = stmtBalance.get(paymentHash) as { balance: number }
    return updated.balance
  })

  const txnDebit = db.transaction((paymentHash: string, amount: number): DebitResult => {
    const row = stmtBalance.get(paymentHash) as { balance: number } | undefined
    const current = row?.balance ?? 0
    if (current < amount) {
      return { success: false, remaining: current }
    }
    const result = stmtDebit.run(amount, paymentHash, amount)
    if (result.changes === 0) {
      return { success: false, remaining: current }
    }
    return { success: true, remaining: current - amount }
  })

  return {
    credit(paymentHash: string, amount: number): void {
      stmtCredit.run(paymentHash, amount)
    },

    debit(paymentHash: string, amount: number): DebitResult {
      return txnDebit(paymentHash, amount)
    },

    adjustCredits(paymentHash: string, delta: number): number {
      return txnAdjustCredits(paymentHash, delta)
    },

    balance(paymentHash: string): number {
      const row = stmtBalance.get(paymentHash) as { balance: number } | undefined
      return row?.balance ?? 0
    },

    settle(paymentHash: string): boolean {
      const result = stmtSettle.run(paymentHash, null)
      return result.changes > 0
    },

    isSettled(paymentHash: string): boolean {
      return !!stmtIsSettled.get(paymentHash)
    },

    settleWithCredit(paymentHash: string, amount: number, settlementSecret?: string): boolean {
      return txnSettleWithCredit(paymentHash, amount, settlementSecret)
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

    storeInvoice(paymentHash: string, bolt11: string, amountSats: number, macaroon: string, statusToken: string): void {
      stmtStoreInvoice.run(paymentHash, bolt11, amountSats, macaroon, statusToken)
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
      const row = stmtGetInvoiceForStatus.get(paymentHash, statusToken) as {
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
