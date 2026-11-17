// Encrypted local keystore: scrypt (N=2^17, r=8, p=1) + AES-256-GCM.
// Two separately encrypted files are used by Paygent:
//   keystore.json  - daemon secrets (spender key, provider API keys, vault key). Unlocked at start.
//   owner.json     - owner signing key. Only the CLI decrypts it, only for approvals/policy edits.
// They use different passphrases so the running daemon can never approve its own payments.

import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const SCRYPT_TEST = { N: 2 ** 12, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

interface SealedFile {
  format: "paygent-keystore-v1";
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  ciphertext: string;
}

function kdfParams() {
  // Tests set PAYGENT_FAST_KDF=1 to keep the suite fast. Never set it in real use.
  return process.env.PAYGENT_FAST_KDF === "1" ? SCRYPT_TEST : SCRYPT;
}

export function seal(plaintext: Buffer, passphrase: string): SealedFile {
  if (passphrase.length < 12) throw new Error("passphrase must be at least 12 characters");
  const salt = randomBytes(16);
  const p = kdfParams();
  const key = scryptSync(passphrase.normalize("NFKC"), salt, 32, p);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from("paygent-keystore-v1"));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  key.fill(0);
  return {
    format: "paygent-keystore-v1",
    kdf: { name: "scrypt", N: p.N, r: p.r, p: p.p, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") },
    ciphertext: ct.toString("base64"),
  };
}

export function unseal(file: SealedFile, passphrase: string): Buffer {
  if (file.format !== "paygent-keystore-v1") throw new Error("unknown keystore format");
  const { N, r, p, salt } = file.kdf;
  if (N > 2 ** 20 || r > 16 || p > 4) throw new Error("keystore KDF parameters out of range");
  const key = scryptSync(passphrase.normalize("NFKC"), Buffer.from(salt, "base64"), 32, { N, r, p, maxmem: 256 * 1024 * 1024 });
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "base64"));
    d.setAAD(Buffer.from("paygent-keystore-v1"));
    d.setAuthTag(Buffer.from(file.cipher.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(file.ciphertext, "base64")), d.final()]);
  } catch {
    throw new Error("wrong passphrase or corrupted keystore");
  } finally {
    key.fill(0);
  }
}

export type Secrets = Record<string, string>;

export class Keystore {
  #secrets: Secrets;
  private constructor(secrets: Secrets) { this.#secrets = secrets; }

  static create(path: string, passphrase: string, initial: Secrets): Keystore {
    writeSealed(path, Buffer.from(JSON.stringify(initial)), passphrase);
    return new Keystore({ ...initial });
  }

  static open(path: string, passphrase: string): Keystore {
    if (!existsSync(path)) throw new Error(`keystore not found at ${path}; run "paygent setup"`);
    const file = JSON.parse(readFileSync(path, "utf8")) as SealedFile;
    const buf = unseal(file, passphrase);
    const secrets = JSON.parse(buf.toString("utf8")) as Secrets;
    buf.fill(0);
    return new Keystore(secrets);
  }

  get(name: string): string | undefined { return this.#secrets[name]; }

  require(name: string): string {
    const v = this.#secrets[name];
    if (v === undefined) throw new Error(`secret "${name}" missing from keystore`);
    return v;
  }

  names(): string[] { return Object.keys(this.#secrets); }

  update(path: string, passphrase: string, changes: Secrets): void {
    const next = { ...this.#secrets, ...changes };
    writeSealed(path, Buffer.from(JSON.stringify(next)), passphrase);
    this.#secrets = next;
  }

  /** Prevent accidental serialization of secrets into logs or MCP responses. */
  toJSON() { return { keystore: "[redacted]", names: this.names() }; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return "Keystore [redacted]"; }
}

function writeSealed(path: string, plaintext: Buffer, passphrase: string) {
  const sealed = seal(plaintext, passphrase);
  plaintext.fill(0);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(sealed, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
