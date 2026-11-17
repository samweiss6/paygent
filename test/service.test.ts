import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { makeHarness, idem, containsPan, ISSUER_DEPOSIT } from "./helpers.ts";
import { AuditLog } from "../src/audit.ts";
import { HARDWARE_APPROVAL_TYPES, hardwareApprovalDomain, signOwner, DOMAIN_UNFREEZE, generateOwnerKey, DOMAIN_APPROVAL } from "../src/crypto/owner.ts";
import { DEFAULT_POLICY } from "../src/policy/schema.ts";

const known = { merchants: { allow: ["bookshop.org"] } };

test("end to end on the wallet path: approve, fund, issue, settle", async () => {
  const h = makeHarness({ policy: known });
  try {
    const p = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "8.00", description: "paperback", idempotency_key: idem() });
    assert.equal(p.status, "issued");
    assert.equal(p.card_cap_usd, "8.40");
    assert.ok(p.card?.last4.match(/^\d{4}$/));
    assert.ok(!containsPan(p));
    const info = await h.authority.info();
    assert.equal(info.remainingUnits, (5000n - 840n) * 10_000n);
    const row = h.ledger.get(p.payment_id)!;
    await h.issuer.simulateCharge!(row.provider_card_id!, 800, "BOOKSHOP.ORG");
    const s = await h.service.refresh(p.payment_id);
    assert.equal(s.status, "settled");
    assert.equal(h.ledger.getVault(p.payment_id), undefined, "vault wiped after settlement");
    assert.ok(AuditLog.verify(join(h.dir, "audit.log")).ok);
  } finally { h.cleanup(); }
});

test("fiat_direct path issues cards with no on-chain movement", async () => {
  const h = makeHarness({ policy: known, path: "fiat_direct" });
  try {
    const before = await h.authority.info();
    const p = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "8.00", description: "paperback", idempotency_key: idem() });
    assert.equal(p.status, "issued");
    assert.equal(p.funding_path, "fiat_direct");
    assert.equal((await h.authority.info()).remainingUnits, before.remainingUnits);
    const b = await h.service.balance();
    assert.equal(b.funding.externalLimit, null);
  } finally { h.cleanup(); }
});

test("fiat_onramp path: owner top-up credits the wallet, then payments draw on it", async () => {
  const { createMockOnramp } = await import("../src/adapters/builtin/mock-onramp.ts");
  const { OnrampTopUps } = await import("../src/funding/wallet.ts");
  const { buildContext } = await import("../src/adapters/context.ts");
  const { mockOnrampManifest } = await import("../src/adapters/builtin/mock-onramp.ts");
  const h = makeHarness({ policy: known, path: "fiat_onramp" });
  try {
    const onramp = createMockOnramp(buildContext(mockOnrampManifest, { config: {}, apiKey: null }), (_to, units) => h.authority.credit(units));
    const topups = new OnrampTopUps(onramp, "0x00000000000000000000000000000000000000aa", "USDC:mock");
    const before = (await h.authority.info()).ownerBalanceUnits;
    const s = await topups.create(2000, idem());
    await onramp.simulateComplete!(s.providerSessionId);
    assert.equal((await topups.status(s.providerSessionId)).state, "completed");
    assert.equal((await h.authority.info()).ownerBalanceUnits, before + 2000n * 10_000n);
    const p = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "3.00", description: "zine", idempotency_key: idem() });
    assert.equal(p.status, "issued");
    assert.equal(p.funding_path, "fiat_onramp");
  } finally { h.cleanup(); }
});

test("issuer that doesn't support the funding model is rejected at startup", async () => {
  const { createLithicSandbox } = await import("../src/adapters/builtin/lithic-sandbox.ts");
  const { buildContext } = await import("../src/adapters/context.ts");
  const { lithicSandboxManifest } = await import("../src/adapters/builtin/lithic-sandbox.ts");
  const issuer = createLithicSandbox(buildContext(lithicSandboxManifest, { config: {}, apiKey: "test", fetchImpl: (async () => { throw new Error("no network"); }) as typeof fetch }));
  assert.throws(() => makeHarness({ issuer, path: "crypto_wallet" }), /does not support funding model/);
});

test("idempotency: same key returns same payment, different params rejected", async () => {
  const h = makeHarness({ policy: known });
  try {
    const key = idem();
    const a = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "4.00", description: "x", idempotency_key: key });
    const b = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "4.00", description: "x", idempotency_key: key });
    assert.equal(a.payment_id, b.payment_id);
    await assert.rejects(h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "40.00", description: "x", idempotency_key: key }), /different parameters/);
    assert.equal((await h.authority.info()).remainingUnits, (5000n - 420n) * 10_000n, "funded once");
  } finally { h.cleanup(); }
});

test("concurrent requests cannot exceed the daily cap", async () => {
  const h = makeHarness({ policy: { ...known, limits: { ...DEFAULT_POLICY.limits, max_payments_per_hour: 100 } } });
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "9.00", description: "item", idempotency_key: idem() })));
    const issued = results.filter((r) => r.status === "issued");
    const capSum = issued.reduce((s, r) => s + Math.round(Number(r.card_cap_usd) * 100), 0);
    assert.ok(capSum <= 5000, `issued ${capSum} cents`);
    assert.equal(issued.length, 5); // 5 x $9.45 = $47.25; a 6th would exceed $50
  } finally { h.cleanup(); }
});

test("on-chain allowance is an independent backstop when policy is looser", async () => {
  // Policy allows $50/day but the on-chain allowance is only $10.
  const h = makeHarness({ policy: known, allowanceCents: 1000 });
  try {
    const a = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "9.00", description: "a", idempotency_key: idem() });
    assert.equal(a.status, "issued");
    const b = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "5.00", description: "b", idempotency_key: idem() });
    assert.equal(b.status, "denied");
    assert.equal(b.deny_reason, "insufficient_allowance");
  } finally { h.cleanup(); }
});

test("owner approval flow, and approvals can't be forged, replayed, or reused", async () => {
  const h = makeHarness();
  try {
    const p = await h.service.requestPayment({ merchant: "newshop.com", amount_usd: "6.00", description: "socks", idempotency_key: idem() });
    assert.equal(p.status, "pending_approval");
    assert.deepEqual(p.approval.reasons, ["new_merchant"]);

    // Forged with a different key
    const attacker = generateOwnerKey();
    const payload = { payment_id: p.payment_id, merchant: "newshop.com", amount_cents: 600, decision: "approve" as const, expires_at: new Date(h.clock.t + 60_000).toISOString() };
    await assert.rejects(h.service.ownerDecision(payload, signOwner(attacker.privateKeyPem, DOMAIN_APPROVAL, payload)), /signature invalid/);
    // Signed over a different amount
    await assert.rejects(h.approve(p.payment_id, "approve", { amount_cents: 60000 }), /does not match/);
    // Policy-domain signature replayed as approval
    await assert.rejects(h.service.ownerDecision(payload, signOwner(h.owner.privateKeyPem, "paygent/policy/v1", payload)), /signature invalid/);

    const approved = await h.approve(p.payment_id) as { status: string };
    assert.equal(approved.status, "issued");
    // Replay the same approval
    await assert.rejects(h.approve(p.payment_id), /payment is issued/);

    // A second payment at the now-known merchant under $10 doesn't need approval
    const q = await h.service.requestPayment({ merchant: "newshop.com", amount_usd: "3.00", description: "more socks", idempotency_key: idem() });
    assert.equal(q.status, "issued");
  } finally { h.cleanup(); }
});

test("pending approvals expire and release the reservation", async () => {
  const h = makeHarness();
  try {
    const p = await h.service.requestPayment({ merchant: "newshop.com", amount_usd: "6.00", description: "socks", idempotency_key: idem() });
    h.clock.t += 31 * 60_000;
    await assert.rejects(h.approve(p.payment_id), /approval window passed|approval expired|payment is expired/);
    assert.equal(h.service.getPayment(p.payment_id).status, "expired");
  } finally { h.cleanup(); }
});

test("hardware approval: owner key alone is not enough above the threshold", async () => {
  const hwKey = generatePrivateKey();
  const hw = privateKeyToAccount(hwKey);
  const h = makeHarness({ policy: {
    merchants: { allow: ["bookshop.org"] },
    limits: { ...DEFAULT_POLICY.limits, per_transaction_usd: "300.00", daily_usd: "500.00", monthly_usd: "500.00", per_merchant_daily_usd: "500.00" },
    approval: { ...DEFAULT_POLICY.approval, hardware_signer_address: hw.address },
  }, allowanceCents: 50000 });
  try {
    const p = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "150.00", description: "textbook", idempotency_key: idem() });
    assert.equal(p.approval.level, "hardware");
    await assert.rejects(h.approve(p.payment_id), /hardware signer/);
    const exp = Math.floor(h.clock.t / 1000) + 300;
    const message = { paymentId: p.payment_id, merchant: "bookshop.org", amountCents: 15000n, expiresAt: BigInt(exp) };
    const other = privateKeyToAccount(generatePrivateKey());
    const badSig = await other.signTypedData({ domain: hardwareApprovalDomain(84532), types: HARDWARE_APPROVAL_TYPES, primaryType: "PaygentApproval", message });
    await assert.rejects(h.service.hardwareApproval({ payment_id: p.payment_id, merchant: "bookshop.org", amount_cents: 15000, expires_at_unix: exp, signature: badSig }), /hardware signature invalid/);
    const sig = await hw.signTypedData({ domain: hardwareApprovalDomain(84532), types: HARDWARE_APPROVAL_TYPES, primaryType: "PaygentApproval", message });
    const r = await h.service.hardwareApproval({ payment_id: p.payment_id, merchant: "bookshop.org", amount_cents: 15000, expires_at_unix: exp, signature: sig });
    assert.equal(r.status, "issued");
  } finally { h.cleanup(); }
});

test("hardware-level payment with no signer configured is denied, not left pending forever", async () => {
  const h = makeHarness({ policy: { merchants: { allow: ["bookshop.org"] }, limits: { ...DEFAULT_POLICY.limits, per_transaction_usd: "300.00", daily_usd: "500.00", monthly_usd: "500.00", per_merchant_daily_usd: "500.00" } }, allowanceCents: 50000 });
  try {
    const p = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "150.00", description: "x", idempotency_key: idem() });
    assert.equal(p.status, "denied");
    assert.equal(p.deny_reason, "hardware_signer_not_configured");
  } finally { h.cleanup(); }
});

test("adapter that ignores the cap or single-use is caught, card frozen, payment failed", async () => {
  for (const misbehave of ["ignore_cap", "multi_use"] as const) {
    const h = makeHarness({ policy: known, issuerMisbehave: misbehave });
    try {
      const p = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "5.00", description: "x", idempotency_key: idem() });
      assert.equal(p.status, "failed", misbehave);
      const row = h.ledger.get(p.payment_id)!;
      assert.equal((await h.issuer.getCardStatus(row.provider_card_id!)).state, "frozen");
      assert.equal(h.ledger.getVault(p.payment_id), undefined);
    } finally { h.cleanup(); }
  }
});

test("kill switch: freezes, revokes on-chain, freezes cards, sweeps, and blocks new payments", async () => {
  const h = makeHarness({ policy: known });
  try {
    const p = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "5.00", description: "x", idempotency_key: idem() });
    const pending = await h.service.requestPayment({ merchant: "newshop.com", amount_usd: "5.00", description: "y", idempotency_key: idem() });
    assert.equal(pending.status, "pending_approval");
    const r = await h.service.kill("test");
    assert.equal(r.frozen, true);
    assert.equal((await h.authority.info()).revoked, true);
    const row = h.ledger.get(p.payment_id)!;
    assert.equal((await h.issuer.getCardStatus(row.provider_card_id!)).state, "frozen");
    assert.equal(h.service.getPayment(p.payment_id).status, "cancelled");
    assert.equal(h.service.getPayment(pending.payment_id).status, "cancelled");
    const after = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "1.00", description: "z", idempotency_key: idem() });
    assert.equal(after.deny_reason, "frozen");
    // Unfreeze needs the owner's signature over frozen_at
    assert.throws(() => h.service.unfreeze("AAAA"), /signature invalid/);
    h.service.unfreeze(signOwner(h.owner.privateKeyPem, DOMAIN_UNFREEZE, { frozen_at: h.service.frozenAt() }));
    // On-chain permission stays revoked: wallet funding is still blocked
    const again = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "1.00", description: "z", idempotency_key: idem() });
    assert.equal(again.status, "denied");
    assert.equal(again.deny_reason, "revoked");
  } finally { h.cleanup(); }
});

test("tampered policy file freezes payments", async () => {
  const h = makeHarness({ policy: known });
  try {
    const path = join(h.dir, "policy.json");
    const p = JSON.parse(readFileSync(path, "utf8"));
    p.limits.per_transaction_usd = "100000.00";
    writeFileSync(path, JSON.stringify(p));
    h.policyStore.reload();
    const r = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "1.00", description: "x", idempotency_key: idem() });
    assert.equal(r.deny_reason, "frozen");
  } finally { h.cleanup(); }
});

test("a signed policy reload never loosens limits until restart", async () => {
  const h = makeHarness({ policy: known });
  try {
    h.setPolicy({ ...DEFAULT_POLICY, merchants: { ...DEFAULT_POLICY.merchants, allow: ["bookshop.org"] }, limits: { ...DEFAULT_POLICY.limits, per_transaction_usd: "200.00" } });
    const r = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "30.00", description: "x", idempotency_key: idem() });
    assert.equal(r.deny_reason, "exceeds_per_transaction_limit");
  } finally { h.cleanup(); }
});

test("card expires unused: frozen, vault wiped, cap released", async () => {
  const h = makeHarness({ policy: known });
  try {
    const p = await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "5.00", description: "x", idempotency_key: idem() });
    h.clock.t += 61 * 60_000;
    const s = await h.service.refresh(p.payment_id);
    assert.equal(s.status, "expired");
    assert.equal(h.ledger.getVault(p.payment_id), undefined);
  } finally { h.cleanup(); }
});

test("funds go only to the configured issuer deposit address", async () => {
  const h = makeHarness({ policy: known });
  try {
    await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "5.00", description: "x", idempotency_key: idem() });
    const state = JSON.parse(readFileSync(join(h.dir, "mock-chain.json"), "utf8"));
    assert.deepEqual(Object.keys(state.forwarded), [ISSUER_DEPOSIT]);
  } finally { h.cleanup(); }
});

test("audit log detects tampering", async () => {
  const h = makeHarness({ policy: known });
  try {
    await h.service.requestPayment({ merchant: "bookshop.org", amount_usd: "5.00", description: "x", idempotency_key: idem() });
    const path = join(h.dir, "audit.log");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const e = JSON.parse(lines[0]); e.data.amount_cents = 1; lines[0] = JSON.stringify(e);
    writeFileSync(path, lines.join("\n") + "\n");
    const v = AuditLog.verify(path);
    assert.equal(v.ok, false);
    assert.ok(!readFileSync(path, "utf8").match(/"pan"\s*:\s*"\d/), "no PAN in audit log");
  } finally { h.cleanup(); }
});
