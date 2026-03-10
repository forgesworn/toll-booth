// src/storage/sqlite.ts
import Database from 'better-sqlite3'
import type { StorageBackend, DebitResult, StoredInvoice, PendingClaim } from './interface.js'

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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS settlements (
      payment_hash TEXT PRIMARY KEY,
      settled_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      payment_hash TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

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
    INSERT OR IGNORE INTO invoices (payment_hash, bolt11, amount_sats, macaroon)
    VALUES (?, ?, ?, ?)
  `)

  const stmtGetInvoice = db.prepare(
    'SELECT payment_hash, bolt11, amount_sats, macaroon, created_at FROM invoices WHERE payment_hash = ?'
  )

  const stmtSettle = db.prepare(
    'INSERT OR IGNORE INTO settlements (payment_hash) VALUES (?)'
  )

  const stmtIsSettled = db.prepare(
    'SELECT 1 FROM settlements WHERE payment_hash = ?'
  )

  const stmtClaim = db.prepare(
    'INSERT OR IGNORE INTO claims (payment_hash, token) VALUES (?, ?)'
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

  const txnClaimForRedeem = db.transaction((paymentHash: string, token: string) => {
    // Reject if already settled
    if (stmtIsSettled.get(paymentHash)) return false
    // Try to claim (INSERT OR IGNORE — fails silently if already claimed)
    const r = stmtClaim.run(paymentHash, token)
    return r.changes > 0
  })

  const txnSettleWithCredit = db.transaction((paymentHash: string, amount: number) => {
    const r = stmtSettle.run(paymentHash)
    if (r.changes > 0) {
      stmtCredit.run(paymentHash, amount)
      stmtDeleteClaim.run(paymentHash)
      return true
    }
    return false
  })

  return {
    credit(paymentHash: string, amount: number): void {
      stmtCredit.run(paymentHash, amount)
    },

    debit(paymentHash: string, amount: number): DebitResult {
      const current = this.balance(paymentHash)
      if (current < amount) {
        return { success: false, remaining: current }
      }
      const result = stmtDebit.run(amount, paymentHash, amount)
      if (result.changes === 0) {
        return { success: false, remaining: this.balance(paymentHash) }
      }
      return { success: true, remaining: current - amount }
    },

    balance(paymentHash: string): number {
      const row = stmtBalance.get(paymentHash) as { balance: number } | undefined
      return row?.balance ?? 0
    },

    settle(paymentHash: string): boolean {
      const result = stmtSettle.run(paymentHash)
      return result.changes > 0
    },

    isSettled(paymentHash: string): boolean {
      return !!stmtIsSettled.get(paymentHash)
    },

    settleWithCredit(paymentHash: string, amount: number): boolean {
      return txnSettleWithCredit(paymentHash, amount)
    },

    claimForRedeem(paymentHash: string, token: string): boolean {
      return txnClaimForRedeem(paymentHash, token)
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

    storeInvoice(paymentHash: string, bolt11: string, amountSats: number, macaroon: string): void {
      stmtStoreInvoice.run(paymentHash, bolt11, amountSats, macaroon)
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

    close(): void {
      db.close()
    },
  }
}
