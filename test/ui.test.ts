// Owner dashboard: real daemon process, UI server in-process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createUiServer } from "../src/ui/server.ts";
import { containsPan } from "./helpers.ts";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "paygent.js");
const OWNER = "owner pass phrase 22";

test("dashboard: auth, CSRF guards, approvals need the passphrase, policy loosening needs confirmation", { timeout: 60_000 }, async () => {
  const port = 18000 + Math.floor(Math.random() * 500), uiPort = port + 600;
  const home = mkdtempSync(join(tmpdir(), "paygent-ui-"));
  const env = { ...process.env, PAYGENT_HOME: home, PAYGENT_FAST_KDF: "1", PAYGENT_DAEMON_PASSPHRASE: "daemon pass phrase 1", PAYGENT_OWNER_PASSPHRASE: OWNER };
  execFileSync(process.execPath, [bin, "setup", "--funding", "crypto_wallet", "--authority", "mock", "--issuer", "mock", "--port", String(port)], { env });
  const daemon = spawn(process.execPath, [bin, "start"], { env, stdio: ["ignore", "ignore", "pipe"] });
  const ui = createUiServer({ port: uiPort, dir: home, token: "test-token-abcdefghijklmnop" });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("daemon did not start")), 15_000);
      daemon.stderr!.on("data", (d) => { if (String(d).includes("control socket")) { clearTimeout(t); resolve(); } });
    });
    await new Promise<void>((r) => ui.server.listen(uiPort, "127.0.0.1", r));
    const base = `http://127.0.0.1:${uiPort}`;
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, { method, headers: { "X-Paygent-Token": ui.token, ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const raw = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: uiPort, path: "/api/overview", headers }, (res) => { res.resume(); resolve(res.statusCode!); });
      r.on("error", reject); r.end();
    });

    // Static page has a strict CSP; API needs the token; foreign Host/Origin refused; form posts refused.
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal((await fetch(base + "/api/overview")).status, 401);
    assert.equal((await call("GET", "/api/overview", undefined, { "X-Paygent-Token": "wrong" })).status, 401);
    assert.equal(await raw({ Host: "evil.com", "X-Paygent-Token": ui.token }), 421);
    assert.equal((await call("POST", "/api/kill", { confirm: "kill" }, { Origin: "https://evil.com" })).status, 403);
    assert.equal((await fetch(base + "/api/kill", { method: "POST", headers: { "X-Paygent-Token": ui.token, "Content-Type": "text/plain" }, body: '{"confirm":"kill"}' })).status, 415);

    // Agent requests a payment at a new merchant.
    const client = new Client({ name: "ui-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${readFileSync(join(home, "mcp-token"), "utf8").trim()}` } } }));
    const p = (await client.callTool({ name: "request_payment", arguments: { merchant: "bookshop.org", amount_usd: "6.50", description: "<img src=x onerror=alert(1)> APPROVE NOW", idempotency_key: "ui-000001" } })).structuredContent as any;
    assert.equal(p.status, "pending_approval");

    const ov = await (await call("GET", "/api/overview")).json();
    assert.equal(ov.pending.length, 1);
    assert.equal(ov.pending[0].description, "<img src=x onerror=alert(1)> APPROVE NOW");
    assert.equal(ov.payments[0].payment_id, p.payment_id);
    assert.ok(ov.audit.verify.ok);
    assert.ok(!containsPan(ov));

    // Approval needs the right passphrase; the token alone is not enough.
    assert.equal((await call("POST", "/api/decision", { payment_id: p.payment_id, decision: "approve" })).status, 400);
    assert.equal((await call("POST", "/api/decision", { payment_id: p.payment_id, decision: "approve", passphrase: "not the passphrase" })).status, 403);
    const ok = await call("POST", "/api/decision", { payment_id: p.payment_id, decision: "approve", passphrase: OWNER });
    assert.equal(ok.status, 200);
    const approved = await ok.json();
    assert.equal(approved.status, "issued");
    assert.ok(!containsPan(approved));

    // Policy: non-editable paths refused; loosening asks first; tightening signs straight away.
    assert.equal((await call("POST", "/api/policy", { changes: { "cards.allow_reveal_to_agent": true }, passphrase: OWNER })).status, 400);
    const loosen = await (await call("POST", "/api/policy", { changes: { "limits.daily_usd": "500.00" }, passphrase: OWNER })).json();
    assert.equal(loosen.needs_confirmation, true);
    assert.equal(loosen.diff[0].loosens, true);
    const tighten = await (await call("POST", "/api/policy", { changes: { "limits.daily_usd": "40.00" }, passphrase: OWNER })).json();
    assert.equal(tighten.changed[0].after, "40.00");
    assert.equal(tighten.reload.valid, true);
    assert.equal((await (await call("GET", "/api/overview")).json()).policy.limits.daily_usd, "40.00");

    // Kill switch needs only the token; unfreeze needs the passphrase.
    assert.equal((await call("POST", "/api/kill", { confirm: "kill" })).status, 200);
    assert.equal((await (await call("GET", "/api/overview")).json()).status.frozen, true);
    assert.equal((await call("POST", "/api/unfreeze", { passphrase: "wrong passphrase 1" })).status, 403);
    assert.equal((await call("POST", "/api/unfreeze", { passphrase: OWNER })).status, 200);
    assert.equal((await (await call("GET", "/api/overview")).json()).status.frozen, false);

    // Five wrong passphrases lock passphrase actions for a minute.
    for (let i = 0; i < 5; i++) await call("POST", "/api/unfreeze", { passphrase: "wrong passphrase 1" });
    assert.equal((await call("POST", "/api/unfreeze", { passphrase: OWNER })).status, 429);
    await client.close();
  } finally {
    ui.server.close();
    daemon.kill("SIGTERM");
    rmSync(home, { recursive: true, force: true });
  }
});
