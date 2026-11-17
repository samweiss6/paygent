import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Ledger } from "../src/ledger.ts";
import { AuditLog } from "../src/audit.ts";
import { PolicyStore } from "../src/policy/store.ts";
import { DEFAULT_POLICY, type Policy } from "../src/policy/schema.ts";
import { generateOwnerKey, signOwner, DOMAIN_APPROVAL, type ApprovalPayload } from "../src/crypto/owner.ts";
import { MockAuthority } from "../src/authority/mock.ts";
import { WalletFunding } from "../src/funding/wallet.ts";
import { FiatDirectFunding } from "../src/funding/fiat-direct.ts";
import { CardVault } from "../src/vault.ts";
import { createMockIssuer } from "../src/adapters/builtin/mock-issuer.ts";
import { buildContext } from "../src/adapters/context.ts";
import { mockIssuerManifest } from "../src/adapters/builtin/mock-issuer.ts";
import { PaymentService } from "../src/service.ts";
import type { IssuerAdapter } from "../src/adapters/types.ts";
import type { FundingPath } from "../src/funding/types.ts";

process.env.PAYGENT_FAST_KDF = "1";

export const ISSUER_DEPOSIT = "0x00000000000000000000000000000000000000d1" as const;

export interface Harness {
  dir: string;
  ledger: Ledger;
  audit: AuditLog;
  policyStore: PolicyStore;
  service: PaymentService;
  issuer: IssuerAdapter;
  authority: MockAuthority;
  owner: ReturnType<typeof generateOwnerKey>;
  approve(paymentId: string, decision?: "approve" | "reject", override?: Partial<ApprovalPayload>): Promise<unknown>;
  setPolicy(p: Policy): void;
  clock: { t: number };
  cleanup(): void;
}

export function makeHarness(opts: {
  policy?: Partial<Policy> & { limits?: Partial<Policy["limits"]>; approval?: Partial<Policy["approval"]>; cards?: Partial<Policy["cards"]>; merchants?: Partial<Policy["merchants"]> };
  issuerMisbehave?: "ignore_cap" | "multi_use";
  issuer?: IssuerAdapter;
  path?: FundingPath;
  allowanceCents?: number;
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "paygent-test-"));
  const clock = { t: Date.parse("2026-11-17T12:00:00Z") };
  const now = () => new Date(clock.t);
  const owner = generateOwnerKey();
  const policy: Policy = {
    ...DEFAULT_POLICY,
    ...opts.policy,
    limits: { ...DEFAULT_POLICY.limits, ...opts.policy?.limits },
    approval: { ...DEFAULT_POLICY.approval, ...opts.policy?.approval },
    cards: { ...DEFAULT_POLICY.cards, ...opts.policy?.cards },
    merchants: { ...DEFAULT_POLICY.merchants, ...opts.policy?.merchants },
  };
  const policyPath = join(dir, "policy.json"), sigPath = join(dir, "policy.sig");
  PolicyStore.write(policyPath, sigPath, policy, owner.privateKeyPem);
  const policyStore = new PolicyStore(policyPath, sigPath, owner.publicKeyPem);
  const ledger = new Ledger(join(dir, "ledger.db"));
  const audit = new AuditLog(join(dir, "audit.log"));
  const authority = new MockAuthority({
    statePath: join(dir, "mock-chain.json"),
    allowanceUnits: BigInt(opts.allowanceCents ?? 5000) * 10_000n,
    now: () => Math.floor(clock.t / 1000),
  });
  const path = opts.path ?? "crypto_wallet";
  const funding = path === "fiat_direct"
    ? new FiatDirectFunding({ issuerId: "mock" })
    : new WalletFunding(authority, { mock: ISSUER_DEPOSIT }, path);
  const issuer = opts.issuer ?? createMockIssuer(buildContext(mockIssuerManifest, { config: {}, apiKey: null }), { misbehave: opts.issuerMisbehave, now: () => clock.t });
  const vault = new CardVault(ledger, randomBytes(32).toString("hex"));
  const service = new PaymentService({
    ledger, audit, policy: policyStore, funding, issuer, vault,
    ownerPublicKeyPem: owner.publicKeyPem, hardwareChainId: 84532, now,
  });
  return {
    dir, ledger, audit, policyStore, service, issuer, authority, owner, clock,
    async approve(paymentId, decision = "approve", override = {}) {
      const row = ledger.get(paymentId)!;
      const payload: ApprovalPayload = {
        payment_id: paymentId, merchant: row.merchant, amount_cents: row.amount_cents, decision,
        expires_at: new Date(clock.t + 5 * 60_000).toISOString(), ...override,
      };
      return service.ownerDecision(payload, signOwner(owner.privateKeyPem, DOMAIN_APPROVAL, payload));
    },
    setPolicy(p) { PolicyStore.write(policyPath, sigPath, p, owner.privateKeyPem); policyStore.reload(); },
    cleanup() { ledger.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

let n = 0;
export const idem = () => `test-key-${process.pid}-${++n}-${Math.random().toString(36).slice(2, 8)}`;

/** Assert that no Luhn-valid PAN-like number appears anywhere in a value. */
export function containsPan(value: unknown): boolean {
  const s = JSON.stringify(value);
  const m = s.match(/(?:\d[ -]?){12,18}\d/g) ?? [];
  return m.some((x) => {
    const d = x.replace(/\D/g, "");
    let sum = 0, alt = false;
    for (let i = d.length - 1; i >= 0; i--) { let k = +d[i]; if (alt) { k *= 2; if (k > 9) k -= 9; } sum += k; alt = !alt; }
    return d.length >= 13 && sum % 10 === 0;
  });
}
