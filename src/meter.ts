// src/meter.ts
import type Database from 'better-sqlite3'

export interface DebitResult {
  success: boolean
  remaining: number
}

export class CreditMeter {
  private db: Database.Database
  private readonly stmtCredit: Database.Statement
  private readonly stmtMarkSettled: Database.Statement
  private readonly stmtDebit: Database.Statement
  private readonly stmtBalance: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credits (
        payment_hash TEXT PRIMARY KEY,
        balance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settled_invoices (
        payment_hash TEXT PRIMARY KEY,
        settled_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    this.stmtCredit = this.db.prepare(`
      INSERT INTO credits (payment_hash, balance)
      VALUES (?, ?)
      ON CONFLICT(payment_hash) DO UPDATE SET
        balance = balance + excluded.balance,
        updated_at = datetime('now')
    `)
    this.stmtMarkSettled = this.db.prepare(`
      INSERT OR IGNORE INTO settled_invoices (payment_hash)
      VALUES (?)
    `)
    this.stmtDebit = this.db.prepare(`
      UPDATE credits SET balance = balance - ?, updated_at = datetime('now')
      WHERE payment_hash = ? AND balance >= ?
    `)
    this.stmtBalance = this.db.prepare(
      'SELECT balance FROM credits WHERE payment_hash = ?'
    )
  }

  credit(paymentHash: string, amountSats: number): void {
    this.stmtCredit.run(paymentHash, amountSats)
  }

  /**
   * Grants the initial invoice credit once per payment hash.
   * Returns true only on the first successful settlement.
   */
  creditOnce(paymentHash: string, amountSats: number): boolean {
    const marked = this.stmtMarkSettled.run(paymentHash)
    if (marked.changes === 0) return false
    this.stmtCredit.run(paymentHash, amountSats)
    return true
  }

  debit(paymentHash: string, amountSats: number): DebitResult {
    const current = this.balance(paymentHash)
    if (current < amountSats) {
      return { success: false, remaining: current }
    }
    const result = this.stmtDebit.run(amountSats, paymentHash, amountSats)
    if (result.changes === 0) {
      return { success: false, remaining: this.balance(paymentHash) }
    }
    return { success: true, remaining: current - amountSats }
  }

  balance(paymentHash: string): number {
    const row = this.stmtBalance.get(paymentHash) as { balance: number } | undefined
    return row?.balance ?? 0
  }

  close(): void {
    this.db.close()
  }
}
