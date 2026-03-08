// src/storage/sqlite.ts
import Database from 'better-sqlite3'
import type { StorageBackend, DebitResult, StoredInvoice } from './interface.js'

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
