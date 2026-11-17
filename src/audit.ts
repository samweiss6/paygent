// Append-only audit log. JSON Lines; each entry commits to the previous entry's hash.
// Tampering with or deleting any entry except the very last breaks verification. Keep a copy of
// `paygent audit head` somewhere else to detect truncation of the tail as well.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, openSync, closeSync } from "node:fs";
import { canonicalJson } from "./crypto/owner.ts";
import { redact } from "./redact.ts";

export interface AuditEntry {
  seq: number;
  ts: string;
  type: string;
  data: Record<string, unknown>;
  prev: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function hashEntry(e: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(canonicalJson(e)).digest("hex");
}

export class AuditLog {
  #path: string;
  #seq = 0;
  #head = GENESIS;

  constructor(path: string) {
    this.#path = path;
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    const result = AuditLog.verify(path);
    if (!result.ok) throw new Error(`audit log failed verification at line ${result.badLine}: ${result.error}`);
    this.#seq = result.count;
    this.#head = result.head;
  }

  append(type: string, data: Record<string, unknown>, now = new Date()): AuditEntry {
    const base = { seq: this.#seq + 1, ts: now.toISOString(), type, data: redact(data) as Record<string, unknown>, prev: this.#head };
    const entry: AuditEntry = { ...base, hash: hashEntry(base) };
    appendFileSync(this.#path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    this.#seq = entry.seq;
    this.#head = entry.hash;
    return entry;
  }

  get head() { return { seq: this.#seq, hash: this.#head }; }

  static verify(path: string): { ok: true; count: number; head: string } | { ok: false; badLine: number; error: string } {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    let prev = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      let e: AuditEntry;
      try { e = JSON.parse(lines[i]); } catch { return { ok: false, badLine: i + 1, error: "not JSON" }; }
      const { hash, ...rest } = e;
      if (e.seq !== i + 1) return { ok: false, badLine: i + 1, error: "sequence gap" };
      if (e.prev !== prev) return { ok: false, badLine: i + 1, error: "chain broken" };
      if (hashEntry(rest) !== hash) return { ok: false, badLine: i + 1, error: "hash mismatch" };
      prev = hash;
    }
    return { ok: true, count: lines.length, head: prev };
  }
}
