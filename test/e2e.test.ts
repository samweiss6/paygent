// End to end with real processes: setup -> daemon -> MCP over HTTP and stdio -> owner approval via CLI -> kill.
import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { containsPan } from "./helpers.ts";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "paygent.js");
const port = 17400 + Math.floor(Math.random() * 500);

test("full flow through the daemon", { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "paygent-e2e-"));
  const env = { ...process.env, PAYGENT_HOME: home, PAYGENT_FAST_KDF: "1", PAYGENT_DAEMON_PASSPHRASE: "daemon pass phrase 1", PAYGENT_OWNER_PASSPHRASE: "owner pass phrase 22" };
  const cli = (...a: string[]) => execFileSync(process.execPath, [bin, ...a], { env, encoding: "utf8" });
  let daemon: ReturnType<typeof spawn> | undefined;
  try {
    cli("setup", "--funding", "crypto_wallet", "--authority", "mock", "--issuer", "mock", "--port", String(port));
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, "keystore.json")).mode & 0o777, 0o600);
    assert.ok(!readFileSync(join(home, "keystore.json"), "utf8").includes("0x"), "keystore is encrypted");

    daemon = spawn(process.execPath, [bin, "start"], { env, stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("daemon did not start")), 15_000);
      daemon!.stderr!.on("data", (d) => { if (String(d).includes("control socket")) { clearTimeout(t); resolve(); } });
      daemon!.on("exit", (c) => reject(new Error(`daemon exited ${c}`)));
    });
    assert.equal(statSync(join(home, "control.sock")).mode & 0o777, 0o600);

    // Unauthenticated and wrong-host requests are refused
    const noAuth = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(noAuth.status, 401);
    const token = readFileSync(join(home, "mcp-token"), "utf8").trim();
    const rebindStatus = await new Promise<number>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { Host: "evil.com", Authorization: `Bearer ${token}` } }, (res) => { res.resume(); resolve(res.statusCode!); });
      r.on("error", reject); r.end("{}");
    });
    assert.equal(rebindStatus, 421, "DNS-rebinding Host header refused");

    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as Record<string, any>;

    const bal = await call("get_balance", {});
    assert.equal(bal.funding.path, "crypto_wallet");
    const p = await call("request_payment", { merchant: "bookshop.org", amount_usd: "6.50", description: "a novel", idempotency_key: "e2e-0000001" });
    assert.equal(p.status, "pending_approval");
    assert.match(cli("pending"), /bookshop\.org/);
    assert.match(cli("approve", p.payment_id), /"status": "issued"/);
    const s = await call("get_payment_status", { payment_id: p.payment_id });
    assert.equal(s.status, "issued");
    assert.ok(!containsPan(s));

    // Same thing over the stdio bridge, the way most agents launch MCP servers
    const stdio = new Client({ name: "e2e-stdio", version: "0" });
    await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env: env as Record<string, string> }));
    const tools = (await stdio.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("request_payment"));
    const viaStdio = (await stdio.callTool({ name: "get_payment_status", arguments: { payment_id: p.payment_id } })).structuredContent as Record<string, any>;
    assert.equal(viaStdio.status, "issued");
    await stdio.close();

    assert.match(cli("kill"), /"frozen": true/);
    const after = await call("request_payment", { merchant: "bookshop.org", amount_usd: "1.00", description: "x", idempotency_key: "e2e-0000002" });
    assert.equal(after.deny_reason, "frozen");
    assert.match(cli("audit", "verify"), /"ok": true/);
    assert.ok(!containsPan(readFileSync(join(home, "audit.log"), "utf8")));
    await client.close();
  } finally {
    daemon?.kill();
    rmSync(home, { recursive: true, force: true });
  }
});
