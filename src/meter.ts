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
  private readonly stmtIsSettled: Database.Statement
  private readonly stmtDeleteSettled: Database.Statement
  private readonly stmtDeleteCredits: Database.Statement
  private readonly stmtRecordRedemption: Database.Statement
  private readonly stmtMarkCreditApplied: Database.Statement
  private readonly txCreditOnce!: (paymentHash: string, amountSats: number) => boolean
  private readonly txSettleRedemption!: (paymentHash: string, amountSats: number) => void

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
        settled_at TEXT NOT NULL DEFAULT (datetime('now')),
        redeemed_amount INTEGER,
        credit_applied INTEGER NOT NULL DEFAULT 0
      )
    `)
    // Migration: add columns if upgrading from older schema
    try { this.db.exec('ALTER TABLE settled_invoices ADD COLUMN redeemed_amount INTEGER') } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE settled_invoices ADD COLUMN credit_applied INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }

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
    this.stmtIsSettled = this.db.prepare(
      'SELECT 1 FROM settled_invoices WHERE payment_hash = ?'
    )
    this.stmtDeleteSettled = this.db.prepare(
      'DELETE FROM settled_invoices WHERE payment_hash = ?'
    )
    this.stmtDeleteCredits = this.db.prepare(
      'DELETE FROM credits WHERE payment_hash = ?'
    )
    this.stmtRecordRedemption = this.db.prepare(
      'UPDATE settled_invoices SET redeemed_amount = ? WHERE payment_hash = ?'
    )
    this.stmtMarkCreditApplied = this.db.prepare(
      'UPDATE settled_invoices SET credit_applied = 1 WHERE payment_hash = ?'
    )
    this.txCreditOnce = this.db.transaction((paymentHash: string, amountSats: number): boolean => {
      const marked = this.stmtMarkSettled.run(paymentHash)
      if (marked.changes === 0) return false
      this.stmtCredit.run(paymentHash, amountSats)
      return true
    })
    this.txSettleRedemption = this.db.transaction((paymentHash: string, amountSats: number): void => {
      // Skip if already settled (idempotent for crash recovery replay)
      const row = this.db.prepare(
        'SELECT credit_applied FROM settled_invoices WHERE payment_hash = ?'
      ).get(paymentHash) as { credit_applied: number } | undefined
      if (row?.credit_applied === 1) return
      this.stmtCredit.run(paymentHash, amountSats)
      this.stmtMarkCreditApplied.run(paymentHash)
    })
  }

  credit(paymentHash: string, amountSats: number): void {
    if (!Number.isInteger(amountSats) || amountSats < 1) {
      throw new RangeError(`amountSats must be a positive integer, got ${amountSats}`)
    }
    this.stmtCredit.run(paymentHash, amountSats)
  }

  /**
   * Claims a payment hash for redemption without crediting.
   * Returns true only on the first successful claim — acts as a
   * cross-instance distributed lock via the `settled_invoices` table.
   * Call `recordRedemption()` + `settleRedemption()` after the external
   * operation succeeds, or `unsettle()` to release the claim on failure.
   */
  claim(paymentHash: string): boolean {
    const result = this.stmtMarkSettled.run(paymentHash)
    return result.changes > 0
  }

  /**
   * Write-ahead: persist the redeemed amount immediately after the
   * external redemption succeeds. If the process crashes before
   * `settleRedemption()`, recovery can replay the credit using
   * this recorded amount.
   */
  recordRedemption(paymentHash: string, amountSats: number): void {
    this.stmtRecordRedemption.run(amountSats, paymentHash)
  }

  /**
   * Atomically credit the balance and mark the redemption as complete.
   * Idempotent: safe to call multiple times (for crash recovery replay).
   */
  settleRedemption(paymentHash: string, amountSats: number): void {
    this.txSettleRedemption(paymentHash, amountSats)
  }

  /**
   * Find settled_invoices rows where the external redemption succeeded
   * (redeemed_amount recorded) but the credit was never applied
   * (process crashed). Replays the credit for each.
   * Returns the number of recovered redemptions.
   */
  recoverPendingRedemptions(): number {
    const rows = this.db.prepare(
      'SELECT payment_hash, redeemed_amount FROM settled_invoices WHERE redeemed_amount IS NOT NULL AND credit_applied = 0'
    ).all() as { payment_hash: string; redeemed_amount: number }[]
    for (const { payment_hash, redeemed_amount } of rows) {
      this.txSettleRedemption(payment_hash, redeemed_amount)
    }
    return rows.length
  }

  /**
   * Remove stale claims that never completed redemption (no redeemed_amount).
   * These are claims where the process crashed during the external redeem()
   * call or the redeem itself failed without cleanup.
   * @param maxAgeSecs — only remove claims older than this (default: 3600 = 1 hour)
   * Returns the number of stale claims removed.
   */
  cleanupStaleClaims(maxAgeSecs = 3600): number {
    const result = this.db.prepare(
      `DELETE FROM settled_invoices
       WHERE redeemed_amount IS NULL
         AND credit_applied = 0
         AND settled_at <= datetime('now', '-' || ? || ' seconds')`
    ).run(maxAgeSecs)
    return result.changes
  }

  /**
   * Grants the initial invoice credit once per payment hash.
   * Returns true only on the first successful settlement.
   * Atomic: marking settled and crediting happen in a single transaction.
   */
  creditOnce(paymentHash: string, amountSats: number): boolean {
    if (!Number.isInteger(amountSats) || amountSats < 1) {
      throw new RangeError(`amountSats must be a positive integer, got ${amountSats}`)
    }
    return this.txCreditOnce(paymentHash, amountSats)
  }

  debit(paymentHash: string, amountSats: number): DebitResult {
    if (!Number.isInteger(amountSats) || amountSats < 1) {
      throw new RangeError(`amountSats must be a positive integer, got ${amountSats}`)
    }
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

  /** Check if a payment hash has already been settled (credited). */
  isSettled(paymentHash: string): boolean {
    return this.stmtIsSettled.get(paymentHash) !== undefined
  }

  balance(paymentHash: string): number {
    const row = this.stmtBalance.get(paymentHash) as { balance: number } | undefined
    return row?.balance ?? 0
  }

  /**
   * Remove a settlement record and its credits, allowing creditOnce to succeed again.
   * Used to roll back when a post-lock operation (e.g. Cashu redemption) fails.
   */
  unsettle(paymentHash: string): void {
    this.db.transaction(() => {
      this.stmtDeleteSettled.run(paymentHash)
      this.stmtDeleteCredits.run(paymentHash)
    })()
  }

  /**
   * Remove credits with zero balance and their corresponding settlement records.
   * Returns the number of rows deleted.
   */
  cleanupDrained(): number {
    // Only remove the zero-balance credits row. The settled_invoices
    // tombstone MUST be preserved — it prevents replay attacks where
    // a spent L402 token (valid macaroon + preimage) is resubmitted
    // to re-credit via creditOnce().
    const result = this.db.prepare('DELETE FROM credits WHERE balance = 0').run()
    return result.changes
  }

  close(): void {
    this.db.close()
  }
}
