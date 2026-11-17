// Loads the signed policy. A missing or bad signature makes the policy "invalid", which the
// engine treats as frozen. On reload, the effective policy is the stricter of old and new until
// the owner restarts, so a reload can never loosen an in-flight decision.

import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { PolicySchema, stricterOf, type Policy } from "./schema.ts";
import { DOMAIN_POLICY, signOwner, verifyOwner } from "../crypto/owner.ts";

export class PolicyStore {
  #policy: Policy | null = null;
  #valid = false;
  #error: string | null = null;

  private policyPath: string;
  private sigPath: string;
  private ownerPublicKeyPem: string;

  constructor(policyPath: string, sigPath: string, ownerPublicKeyPem: string) {
    this.policyPath = policyPath;
    this.sigPath = sigPath;
    this.ownerPublicKeyPem = ownerPublicKeyPem;
    this.reload();
  }

  reload(): void {
    try {
      if (!existsSync(this.policyPath) || !existsSync(this.sigPath)) throw new Error("policy or signature file missing");
      const raw = JSON.parse(readFileSync(this.policyPath, "utf8"));
      const sig = readFileSync(this.sigPath, "utf8").trim();
      if (!verifyOwner(this.ownerPublicKeyPem, DOMAIN_POLICY, raw, sig)) throw new Error("policy signature invalid");
      const parsed = PolicySchema.parse(raw);
      this.#policy = this.#policy ? stricterOf(this.#policy, parsed) : parsed;
      this.#valid = true;
      this.#error = null;
    } catch (e) {
      this.#valid = false;
      this.#error = (e as Error).message;
    }
  }

  get valid() { return this.#valid; }
  get error() { return this.#error; }

  /** The active policy. When invalid, callers get the last valid policy (or null) and must deny. */
  get policy(): Policy | null { return this.#policy; }

  static write(policyPath: string, sigPath: string, policy: Policy, ownerPrivateKeyPem: string): void {
    const parsed = PolicySchema.parse(policy);
    const sig = signOwner(ownerPrivateKeyPem, DOMAIN_POLICY, parsed);
    writeFileSync(policyPath + ".tmp", JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(sigPath + ".tmp", sig + "\n", { mode: 0o600 });
    renameSync(policyPath + ".tmp", policyPath);
    renameSync(sigPath + ".tmp", sigPath);
  }
}
