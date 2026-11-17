// Local ledger on node:sqlite. All cap accounting happens in synchronous transactions, so the
// decision and the reservation for one request can't interleave with another request.

import { DatabaseSync } from "node:sqlite";
import type { LedgerView } from "./policy/engine.ts";

export type PaymentStatus =
  | "denied" | "pending_approval" | "rejected" | "approved" | "funding" | "issued"
  | "settled" | "declined" | "cancelled" | "expired" | "failed";

/** Statuses whose amount counts against caps. */
export const COMMITTED: PaymentStatus[] = ["pending_approval", "approved", "funding", "issued", "settled"];
export const TERMINAL: PaymentStatus[] = ["denied", "rejected", "settled", "declined", "cancelled", "expired", "failed"];

export interface PaymentRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  merchant: string;
  amount_cents: number;
  cap_cents: number;
  description: string;
  status: PaymentStatus;
  approval_level: "none" | "owner" | "hardware";
  approval_reasons: string;     // JSON array
  deny_reason: string | null;
  owner_approved: number;       // 0/1
  issuer_id: string | null;
  provider_card_id: string | null;
  last4: string | null;
  card_expires_at: string | null;
  funding_ref: string | null;
  settled_cents: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  approval_expires_at: string | null;
}

export class Ledger {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        merchant TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        cap_cents INTEGER NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_level TEXT NOT NULL,
        approval_reasons TEXT NOT NULL DEFAULT '[]',
        deny_reason TEXT,
        owner_approved INTEGER NOT NULL DEFAULT 0,
        issuer_id TEXT,
        provider_card_id TEXT,
        last4 TEXT,
        card_expires_at TEXT,
        funding_ref TEXT,
        settled_cents INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approval_expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS payments_created ON payments(created_at);
      CREATE INDEX IF NOT EXISTS payments_merchant ON payments(merchant);
      CREATE TABLE IF NOT EXISTS vault (payment_id TEXT PRIMARY KEY REFERENCES payments(id), sealed TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  isFrozen(): boolean { return this.getMeta("frozen") === "1"; }

  view(merchant: string, now: Date, policyValid: boolean): LedgerView {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
    const placeholders = COMMITTED.map(() => "?").join(",");
    const sum = (since: string, m?: string) => {
      const sql = `SELECT COALESCE(SUM(CASE WHEN status = 'settled' AND settled_cents IS NOT NULL THEN settled_cents ELSE cap_cents END), 0) AS s
                   FROM payments WHERE status IN (${placeholders}) AND created_at >= ?${m ? " AND merchant = ?" : ""}`;
      const args: (string | number)[] = [...COMMITTED, since];
      if (m) args.push(m);
      return (this.db.prepare(sql).get(...args) as { s: number }).s;
    };
    const lastHour = (this.db.prepare("SELECT COUNT(*) AS c FROM payments WHERE status != 'denied' AND created_at >= ?").get(hourAgo) as { c: number }).c;
    const known = this.db.prepare("SELECT 1 FROM payments WHERE merchant = ? AND (owner_approved = 1 OR status = 'settled') LIMIT 1").get(merchant);
    return {
      frozen: this.isFrozen(),
      policyValid,
      dayCommittedCents: sum(dayStart),
      monthCommittedCents: sum(monthStart),
      merchantDayCommittedCents: sum(dayStart, merchant),
      paymentsLastHour: lastHour,
      merchantKnown: known !== undefined,
    };
  }

  insert(p: PaymentRow) {
    const cols = Object.keys(p);
    this.db.prepare(`INSERT INTO payments (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .run(...(Object.values(p) as (string | number | null)[]));
  }

  get(id: string): PaymentRow | undefined {
    return this.db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as PaymentRow | undefined;
  }

  getByIdempotencyKey(key: string): PaymentRow | undefined {
    return this.db.prepare("SELECT * FROM payments WHERE idempotency_key = ?").get(key) as PaymentRow | undefined;
  }

  update(id: string, changes: Partial<PaymentRow>, now: Date) {
    const entries = Object.entries({ ...changes, updated_at: now.toISOString() });
    this.db.prepare(`UPDATE payments SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...(entries.map(([, v]) => v) as (string | number | null)[]), id);
  }

  /** Compare-and-set on status, so two callers can't both move a payment forward. */
  transition(id: string, from: PaymentStatus[], to: PaymentStatus, now: Date, extra: Partial<PaymentRow> = {}): boolean {
    const entries = Object.entries({ ...extra, status: to, updated_at: now.toISOString() });
    const r = this.db.prepare(
      `UPDATE payments SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
    ).run(...(entries.map(([, v]) => v) as (string | number | null)[]), id, ...from);
    return Number(r.changes) === 1;
  }

  listByStatus(statuses: PaymentStatus[]): PaymentRow[] {
    return this.db.prepare(`SELECT * FROM payments WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at`)
      .all(...statuses) as unknown as PaymentRow[];
  }

  putVault(paymentId: string, sealed: string) {
    this.db.prepare("INSERT OR REPLACE INTO vault(payment_id, sealed) VALUES (?, ?)").run(paymentId, sealed);
  }

  getVault(paymentId: string): string | undefined {
    return (this.db.prepare("SELECT sealed FROM vault WHERE payment_id = ?").get(paymentId) as { sealed: string } | undefined)?.sealed;
  }

  wipeVault(paymentId: string) {
    this.db.prepare("DELETE FROM vault WHERE payment_id = ?").run(paymentId);
  }

  close() { this.db.close(); }
}
