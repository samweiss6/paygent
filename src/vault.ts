// Card vault. PANs are sealed with AES-256-GCM under a random vault key from the keystore.
// Only the checkout injector and the owner reveal path call open(). Nothing here logs.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Ledger } from "./ledger.ts";

export interface CardSecret { pan: string; cvv: string; expMonth: string; expYear: string }

export class CardVault {
  #key: Buffer;
  #ledger: Ledger;

  constructor(ledger: Ledger, vaultKeyHex: string) {
    if (!/^[0-9a-f]{64}$/.test(vaultKeyHex)) throw new Error("vault key must be 32 bytes hex");
    this.#key = Buffer.from(vaultKeyHex, "hex");
    this.#ledger = ledger;
  }

  put(paymentId: string, card: CardSecret) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#key, iv);
    c.setAAD(Buffer.from(paymentId));
    const ct = Buffer.concat([c.update(JSON.stringify(card)), c.final()]);
    this.#ledger.putVault(paymentId, [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join("."));
  }

  open(paymentId: string): CardSecret | null {
    const sealed = this.#ledger.getVault(paymentId);
    if (!sealed) return null;
    const [iv, tag, ct] = sealed.split(".").map((s) => Buffer.from(s, "base64"));
    const d = createDecipheriv("aes-256-gcm", this.#key, iv);
    d.setAAD(Buffer.from(paymentId));
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
  }

  wipe(paymentId: string) { this.#ledger.wipeVault(paymentId); }

  toJSON() { return "[vault]"; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return "CardVault [redacted]"; }
}
