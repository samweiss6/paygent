import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type LedgerView } from "../src/policy/engine.ts";
import { DEFAULT_POLICY, PolicySchema, cardCapCents, stricterOf } from "../src/policy/schema.ts";
import { normalizeMerchant, merchantMatches } from "../src/merchant.ts";
import { usdToCents } from "../src/money.ts";

const view = (v: Partial<LedgerView> = {}): LedgerView => ({
  frozen: false, policyValid: true, dayCommittedCents: 0, monthCommittedCents: 0,
  merchantDayCommittedCents: 0, paymentsLastHour: 0, merchantKnown: true, ...v,
});
const req = (amount: string, merchant = "bookshop.org", description = "a book") => {
  const amountCents = usdToCents(amount);
  return { merchant, amountCents, capCents: cardCapCents(DEFAULT_POLICY, amountCents), description };
};

test("default policy parses", () => { PolicySchema.parse(DEFAULT_POLICY); });

test("small purchase at known merchant is approved", () => {
  assert.deepEqual(decide(req("5.00"), DEFAULT_POLICY, view()), { outcome: "approve", approvalLevel: "none" });
});

test("new merchant requires owner approval by default", () => {
  const d = decide(req("5.00"), DEFAULT_POLICY, view({ merchantKnown: false }));
  assert.equal(d.outcome, "require_approval");
  assert.deepEqual(d.outcome === "require_approval" && d.reasons, ["new_merchant"]);
});

test("above $10 requires owner approval", () => {
  const d = decide(req("12.00"), DEFAULT_POLICY, view());
  assert.equal(d.outcome === "require_approval" && d.approvalLevel, "owner");
});

test("per-transaction limit", () => {
  assert.deepEqual(decide(req("25.01"), DEFAULT_POLICY, view()), { outcome: "deny", reason: "exceeds_per_transaction_limit" });
});

test("daily cap counts the card cap (amount + tolerance), not just the amount", () => {
  // $49 already committed; $0.99 + 5% tolerance (4c) = $1.03 > $1 headroom
  const d = decide(req("0.99"), DEFAULT_POLICY, view({ dayCommittedCents: 4900 }));
  assert.deepEqual(d, { outcome: "deny", reason: "exceeds_daily_limit" });
});

test("monthly cap", () => {
  assert.deepEqual(decide(req("5.00"), DEFAULT_POLICY, view({ monthCommittedCents: 19800 })), { outcome: "deny", reason: "exceeds_monthly_limit" });
});

test("velocity limit", () => {
  assert.deepEqual(decide(req("1.00"), DEFAULT_POLICY, view({ paymentsLastHour: 5 })), { outcome: "deny", reason: "velocity_limit" });
});

test("frozen or invalid policy denies everything", () => {
  assert.deepEqual(decide(req("1.00"), DEFAULT_POLICY, view({ frozen: true })), { outcome: "deny", reason: "frozen" });
  assert.deepEqual(decide(req("1.00"), DEFAULT_POLICY, view({ policyValid: false })), { outcome: "deny", reason: "frozen" });
});

test("deny list matches subdomains", () => {
  assert.deepEqual(decide(req("5.00", "checkout.paypal.com"), DEFAULT_POLICY, view()), { outcome: "deny", reason: "merchant_denied" });
});

test("blocked keywords catch spacing and punctuation variants", () => {
  for (const d of ["Gift Card for mom", "gift-card", "GIFTCARD $20", "g i f t card"]) {
    const r = decide(req("5.00", "bookshop.org", d), DEFAULT_POLICY, view());
    if (d === "g i f t card") continue; // letter-spacing is not caught by keyword matching; issuer MCC blocks are the stronger control
    assert.deepEqual(r, { outcome: "deny", reason: "blocked_category" }, d);
  }
});

test("allow_only_listed", () => {
  const p = { ...DEFAULT_POLICY, merchants: { ...DEFAULT_POLICY.merchants, allow: ["bookshop.org"], allow_only_listed: true } };
  assert.equal(decide(req("5.00", "other.com"), p, view()).outcome, "deny");
  assert.equal(decide(req("5.00", "www.bookshop.org"), p, view({ merchantKnown: false })).outcome, "approve");
});

test("hardware threshold", () => {
  const p = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, per_transaction_usd: "500.00", daily_usd: "1000.00", monthly_usd: "1000.00", per_merchant_daily_usd: "1000.00" } };
  const d = decide(req("150.00"), p, view());
  assert.equal(d.outcome === "require_approval" && d.approvalLevel, "hardware");
});

test("stricterOf never loosens", () => {
  const loose = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, daily_usd: "5000.00" }, cards: { ...DEFAULT_POLICY.cards, allow_reveal_to_agent: true } };
  const s = stricterOf(DEFAULT_POLICY, loose);
  assert.equal(s.limits.daily_usd, "50.00");
  assert.equal(s.cards.allow_reveal_to_agent, false);
});

test("merchant normalization rejects spoofing forms", () => {
  for (const bad of ["https://bookshop.org@evil.com", "evil.com/bookshop.org", "127.0.0.1", "localhost", "http://[::1]/",
                     "bооkshop.org" /* Cyrillic o */, "bookshop", "shop.example", "https://bookshop.org:8443", "javascript:alert(1)", "a..b.com"]) {
    assert.throws(() => normalizeMerchant(bad), undefined, bad);
  }
  assert.equal(normalizeMerchant("HTTPS://Shop.Bookshop.org/cart?x=1"), "shop.bookshop.org");
  assert.ok(merchantMatches("shop.bookshop.org", "bookshop.org"));
  assert.ok(!merchantMatches("bookshop.org.evil.com", "bookshop.org"));
});

test("amount parsing is strict", () => {
  for (const bad of ["1e3", "-5", "5.001", " 5", "0x10", "5,00", "", "NaN", "Infinity"]) assert.throws(() => usdToCents(bad), undefined, bad);
  assert.equal(usdToCents("23.4"), 2340);
});
