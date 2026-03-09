// src/invoice-store.ts
import type Database from 'better-sqlite3'

export interface StoredInvoice {
  paymentHash: string
  bolt11: string
  amountSats: number
  macaroon: string
  createdAt: string
}

export class InvoiceStore {
  private readonly db: Database.Database
  private readonly stmtStore: Database.Statement
  private readonly stmtGet: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS invoices (
        payment_hash TEXT PRIMARY KEY,
        bolt11 TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        macaroon TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    this.stmtStore = db.prepare(`
      INSERT OR IGNORE INTO invoices (payment_hash, bolt11, amount_sats, macaroon)
      VALUES (?, ?, ?, ?)
    `)
    this.stmtGet = db.prepare(
      'SELECT payment_hash, bolt11, amount_sats, macaroon, created_at FROM invoices WHERE payment_hash = ?'
    )
  }

  store(paymentHash: string, bolt11: string, amountSats: number, macaroon: string): void {
    this.stmtStore.run(paymentHash, bolt11, amountSats, macaroon)
  }

  /**
   * Remove invoices older than `maxAgeSecs` seconds.
   * Returns the number of rows deleted.
   */
  cleanup(maxAgeSecs: number): number {
    const result = this.db.prepare(
      "DELETE FROM invoices WHERE created_at < datetime('now', '-' || ? || ' seconds')"
    ).run(maxAgeSecs)
    return result.changes
  }

  get(paymentHash: string): StoredInvoice | undefined {
    const row = this.stmtGet.get(paymentHash) as {
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
  }
}
