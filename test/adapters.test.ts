import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { startSandboxedAdapter } from "../src/adapters/host.ts";
import { buildContext, hostAllowed } from "../src/adapters/context.ts";
import { createLithicSandbox, lithicSandboxManifest } from "../src/adapters/builtin/lithic-sandbox.ts";
import { Keystore } from "../src/crypto/keystore.ts";
import { redact, redactString } from "../src/redact.ts";
import "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("third-party adapter runs in a sandbox and works through the proxy", async () => {
  const a = await startSandboxedAdapter({ adapterDir: join(here, "..", "examples", "third-party-adapter"), config: {}, apiKey: "k" });
  try {
    const issuer = a.proxy as import("../src/adapters/types.ts").IssuerAdapter;
    const card = await issuer.createCard({ amountCents: 500, merchant: "bookshop.org", expiresAt: new Date(Date.now() + 3600e3).toISOString(), idempotencyKey: "k1", memo: "m" });
    assert.equal(card.last4, "0002");
    await issuer.freezeCard(card.providerCardId);
    assert.equal((await issuer.getCardStatus(card.providerCardId)).state, "frozen");
  } finally { a.close(); }
});

test("malicious adapter can't read secrets, write files, spawn processes, see env, or fetch unlisted hosts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paygent-secret-"));
  const secret = join(dir, "keystore.json");
  writeFileSync(secret, "SECRET");
  process.env.PAYGENT_TEST_SECRET_PATH = secret;
  const logs: string[] = [];
  const a = await startSandboxedAdapter({ adapterDir: join(here, "fixtures", "evil-adapter"), config: {}, apiKey: null, onLog: (l) => logs.push(l) });
  try {
    const issuer = a.proxy as import("../src/adapters/types.ts").IssuerAdapter;
    const err = await issuer.createCard({ amountCents: 500, merchant: "x.com", expiresAt: new Date().toISOString(), idempotencyKey: "k", memo: secret }).catch((e) => e as Error);
    const attempts = JSON.parse(String((err as Error).message).split("ATTEMPTS ")[1]);
    assert.equal(attempts.readKeystore, "ERR_ACCESS_DENIED");
    assert.equal(attempts.writeFile, "ERR_ACCESS_DENIED");
    assert.notEqual(attempts.spawn, "ALLOWED");
    assert.equal(attempts.env, "NO_ENV");
    assert.equal(attempts.fetchEvil, "blocked");
    assert.equal(attempts.globalFetch, "absent");
    assert.equal(attempts.globalWebSocket, "absent");
    for (const m of ["node:net", "node:https", "node:http", "node:tls", "node:dgram", "node:dns", "node:vm", "node:worker_threads"]) {
      assert.notEqual(attempts[m], "ALLOWED", m);
    }
    assert.equal(attempts.binding, "blocked");
    assert.equal(attempts.getBuiltin, "ERR_PAYGENT_BLOCKED_MODULE");
    assert.notEqual(attempts.requireNet, "ALLOWED");
    assert.ok(!existsSync(secret + ".pwned"));
  } finally {
    a.close();
    delete process.env.PAYGENT_TEST_SECRET_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restricted fetch: https + allowlisted host only, no redirects", async () => {
  assert.ok(hostAllowed("https://sandbox.lithic.com/v1/cards", ["sandbox.lithic.com"]));
  for (const bad of ["http://sandbox.lithic.com/", "https://api.lithic.com/", "https://sandbox.lithic.com.evil.com/", "https://user@sandbox.lithic.com/"]) {
    assert.ok(!hostAllowed(bad, ["sandbox.lithic.com"]), bad);
  }
  let seen: RequestInit | undefined;
  const ctx = buildContext(lithicSandboxManifest, { config: {}, apiKey: "x", fetchImpl: (async (_u: string, init?: RequestInit) => { seen = init; return new Response("{}"); }) as typeof fetch });
  await ctx.http("https://sandbox.lithic.com/v1/x");
  assert.equal(seen?.redirect, "error");
  await assert.rejects(ctx.http("https://api.lithic.com/v1/cards"), /not in allowedHosts/);
});

test("lithic sandbox adapter maps the API and never reaches production", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/cards") && init?.method === "POST") {
      return new Response(JSON.stringify({ token: "c0ffee00-0000-0000-0000-000000000001", last_four: "1111", pan: "4111111111111111", cvv: "321", exp_month: "08", exp_year: "2029", state: "OPEN", type: "SINGLE_USE", spend_limit: 525, spend_limit_duration: "TRANSACTION" }));
    }
    if (url.includes("/transactions")) return new Response(JSON.stringify({ data: [{ amount: 500, status: "SETTLED", merchant: { descriptor: "BOOKSHOP" } }] }));
    return new Response(JSON.stringify({ token: "c0ffee00-0000-0000-0000-000000000001", state: "CLOSED", type: "SINGLE_USE", spend_limit: 525, spend_limit_duration: "TRANSACTION", last_four: "1111" }));
  }) as typeof fetch;
  const issuer = createLithicSandbox(buildContext(lithicSandboxManifest, { config: {}, apiKey: "sandbox-key", fetchImpl, logSink: () => {} }));
  const card = await issuer.createCard({ amountCents: 525, merchant: "bookshop.org", expiresAt: new Date(Date.now() + 3600e3).toISOString(), idempotencyKey: "pay_0b6f2a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", memo: "paygent test" });
  const h = calls[0].init?.headers as Record<string, string>;
  assert.equal(h.Authorization, "sandbox-key", "raw key, no prefix");
  assert.equal(h["Idempotency-Key"], "0b6f2a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
  assert.equal(card.controls.capCents, 525);
  assert.equal(card.controls.singleUse, true);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.type, "SINGLE_USE");
  assert.equal(body.spend_limit, 525);
  assert.ok(calls.every((c) => c.url.startsWith("https://sandbox.lithic.com/")));
  const st = await issuer.getCardStatus(card.providerCardId);
  assert.equal(st.state, "used");
});

test("keystore round trip, wrong passphrase, and redacted serialization", () => {
  const dir = mkdtempSync(join(tmpdir(), "paygent-ks-"));
  try {
    const path = join(dir, "ks.json");
    Keystore.create(path, "correct horse battery", { spender: "0x" + "ab".repeat(32) });
    assert.equal(Keystore.open(path, "correct horse battery").get("spender"), "0x" + "ab".repeat(32));
    assert.throws(() => Keystore.open(path, "wrong passphrase!!"), /wrong passphrase/);
    assert.throws(() => Keystore.create(join(dir, "x"), "short", {}), /at least 12/);
    const ks = Keystore.open(path, "correct horse battery");
    assert.ok(!JSON.stringify({ ks }).includes("abab"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("redaction removes PANs, keys, and secret-named fields", () => {
  assert.equal(redactString("card 4111 1111 1111 1111 ok"), "card [redacted-pan] ok");
  assert.equal(redactString("order 1234567890123"), "order 1234567890123", "non-Luhn numbers kept");
  assert.ok(!JSON.stringify(redact({ pan: "4111111111111111", nested: { apiKey: "sk_test_x", note: "0x" + "1".repeat(64) } })).match(/4111|sk_test|1111111111/));
});
