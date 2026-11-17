// paygent CLI. Owner commands talk to the daemon over the 0600 Unix socket and sign anything that
// increases authority with the owner key (decrypted here, in the CLI process, never in the daemon).

import http from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { paths as getPaths, ensureDir, writeConfig, readConfig, isLoopback, type Config } from "./config.ts";
import { Keystore } from "./crypto/keystore.ts";
import { generateOwnerKey, signOwner, DOMAIN_APPROVAL, DOMAIN_UNFREEZE, HARDWARE_APPROVAL_TYPES, hardwareApprovalDomain, type ApprovalPayload } from "./crypto/owner.ts";
import { DEFAULT_POLICY, PolicySchema, type Policy } from "./policy/schema.ts";
import { PolicyStore } from "./policy/store.ts";
import { AuditLog } from "./audit.ts";
import { proposePermission } from "./authority/spend-permission.ts";
import { centsToUsdcUnits, usdToCents, centsToUsd } from "./money.ts";
import { readManifest } from "./adapters/host.ts";

const P = getPaths();
const out = (x: unknown) => process.stdout.write((typeof x === "string" ? x : JSON.stringify(x, null, 2)) + "\n");
const die = (msg: string): never => { process.stderr.write(`paygent: ${msg}\n`); process.exit(1); };

// ---------- prompts ----------

async function ask(q: string, def?: string): Promise<string> {
  if (!process.stdin.isTTY) return def ?? die(`"${q}" needs an answer; pass flags for non-interactive use`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const a = await new Promise<string>((r) => rl.question(`${q}${def ? ` [${def}]` : ""}: `, r));
  rl.close();
  return a.trim() || def || "";
}

async function secret(q: string, envName: string): Promise<string> {
  if (process.env[envName]) return process.env[envName]!;
  if (envName === "PAYGENT_DAEMON_PASSPHRASE" && process.env.PAYGENT_PASSPHRASE_FILE) return readFileSync(process.env.PAYGENT_PASSPHRASE_FILE, "utf8").trim();
  if (!process.stdin.isTTY) die(`${q}: no TTY; set ${envName}`);
  process.stderr.write(`${q}: `);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = "";
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); process.stderr.write("\n"); resolve(buf); }
      else if (ch === "\u0003") process.exit(130);
      else if (ch === "\u007f") buf = buf.slice(0, -1);
      else buf += ch;
    };
    stdin.on("data", onData);
  });
}

async function newSecret(label: string, envName: string): Promise<string> {
  const a = await secret(`${label} (12+ characters)`, envName);
  if (a.length < 12) die("passphrase must be at least 12 characters");
  if (!process.env[envName]) { const b = await secret(`Repeat ${label.toLowerCase()}`, envName + "_CONFIRM"); if (a !== b) die("passphrases don't match"); }
  return a;
}

async function ownerKey(): Promise<string> {
  const pass = await secret("Owner passphrase", "PAYGENT_OWNER_PASSPHRASE");
  return Keystore.open(P.owner, pass).require("owner_private_key_pem");
}

// ---------- control socket ----------

function control(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: P.socket, path, method, headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if ((res.statusCode ?? 500) >= 400) reject(new Error(data.error?.message ?? data.error ?? `HTTP ${res.statusCode}`)); else resolve(data);
      });
    });
    req.on("error", (e: NodeJS.ErrnoException) => reject(new Error(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? `daemon not running (no socket at ${P.socket}); run "paygent start"` : e.message)));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

// ---------- commands ----------

async function setup(args: string[]) {
  if (existsSync(P.config) && !args.includes("--force")) die(`already set up at ${P.dir} (use --force to overwrite)`);
  ensureDir(P.dir);
  out(`Paygent setup. TEST MODE ONLY: no real money, no live provider keys.\nData directory: ${P.dir}\n`);

  out(`How will cards be funded?
  fiat_direct   - your bank account or debit card, linked inside the card issuer's account. No crypto. (recommended)
  fiat_onramp   - buy USDC with your bank/debit through an on-ramp into your own smart wallet; cards draw on it
  crypto_wallet - USDC you already hold in your own smart wallet`);
  const path = (flag(args, "funding") ?? await ask("Funding path", "fiat_direct")) as Config["funding"]["path"];
  if (!["fiat_direct", "fiat_onramp", "crypto_wallet"].includes(path)) die("unknown funding path");

  let authority: Config["funding"]["authority"] = null;
  let ownerWallet: string | null = flag(args, "owner-wallet") ?? null;
  let rpc: string | null = null;
  if (path !== "fiat_direct") {
    authority = (flag(args, "authority") ?? await ask("Spend authority: mock (dry run) or base-sepolia (testnet)", "mock")) as "mock" | "base-sepolia";
    if (authority === "base-sepolia") {
      ownerWallet ??= await ask("Your smart wallet address on Base Sepolia (Coinbase Smart Wallet or another account with spend permissions)");
      rpc = flag(args, "rpc-url") ?? await ask("Base Sepolia RPC URL", "https://sepolia.base.org");
    }
    if (path === "fiat_onramp") ownerWallet ??= "0x00000000000000000000000000000000000000aa";
  }

  const issuerArg = flag(args, "issuer") ?? await ask("Card issuer: mock, lithic-sandbox, or a path to a third-party adapter", "mock");
  let issuerId = issuerArg, externalDir: string | null = null;
  if (!["mock", "lithic-sandbox"].includes(issuerArg)) {
    const m = readManifest(issuerArg);
    if (m.kind !== "issuer") die("that adapter is not an issuer");
    out(`Third-party adapter "${m.id}" will run sandboxed and may contact: ${m.allowedHosts.join(", ") || "(no hosts)"}`);
    if ((flag(args, "yes") === undefined && !args.includes("--yes")) && (await ask("Allow? (yes/no)", "no")) !== "yes") die("aborted");
    issuerId = m.id; externalDir = issuerArg;
  }

  const daemonPass = await newSecret("Daemon passphrase (unlocks spender and provider keys at start)", "PAYGENT_DAEMON_PASSPHRASE");
  const ownerPass = await newSecret("Owner passphrase (approvals and policy changes; must differ)", "PAYGENT_OWNER_PASSPHRASE");
  if (daemonPass === ownerPass) die("owner and daemon passphrases must differ, or the daemon could approve its own payments");

  const owner = generateOwnerKey();
  Keystore.create(P.owner, ownerPass, { owner_private_key_pem: owner.privateKeyPem });
  writeFileSync(P.ownerPub, owner.publicKeyPem, { mode: 0o644 });
  const spenderKey = generatePrivateKey();
  const spender = privateKeyToAccount(spenderKey).address;
  const mcpToken = randomBytes(32).toString("base64url");
  const secrets: Record<string, string> = { spender_private_key: spenderKey, vault_key: randomBytes(32).toString("hex") };
  if (issuerId === "lithic-sandbox") {
    const k = process.env.PAYGENT_LITHIC_SANDBOX_KEY ?? await secret("Lithic SANDBOX API key (leave empty to add later)", "PAYGENT_LITHIC_SANDBOX_KEY");
    if (k) secrets["lithic-sandbox.api_key"] = k;
  }
  Keystore.create(P.keystore, daemonPass, secrets);
  writeFileSync(P.mcpToken, mcpToken + "\n", { mode: 0o600 });

  const policy: Policy = structuredClone(DEFAULT_POLICY);
  PolicyStore.write(P.policy, P.policySig, policy, owner.privateKeyPem);

  let permission: Record<string, unknown> | null = null;
  if (authority === "base-sepolia") {
    permission = { ...proposePermission({ account: ownerWallet as `0x${string}`, spender, dailyAllowanceUnits: centsToUsdcUnits(usdToCents(policy.limits.daily_usd)), durationDays: 30 }) };
  }
  const deposit = (ownerWallet ?? "0x00000000000000000000000000000000000000d1") as `0x${string}`;
  const config: Config = {
    version: 1,
    funding: {
      path, authority, rpc_url: rpc, permission, owner_wallet: ownerWallet,
      // Test mode: "issuer deposits" go back to the owner's own wallet, so testnet funds never leave the owner.
      issuer_deposit_addresses: path === "fiat_direct" ? {} : { [issuerId]: deposit },
      onramp: path === "fiat_onramp" ? "mock-onramp" : null,
    },
    issuer: { id: issuerId, external_dir: externalDir, config: {} },
    mcp: { host: "127.0.0.1", port: Number(flag(args, "port") ?? 7402), tls_cert: null, tls_key: null },
    hardware_chain_id: 84532,
  };
  writeConfig(P, config, owner.privateKeyPem);
  new AuditLog(P.audit).append("setup_completed", { funding_path: path, authority, issuer: issuerId });

  out(`\nDone. Policy defaults: $${policy.limits.per_transaction_usd}/payment, $${policy.limits.daily_usd}/day, $${policy.limits.monthly_usd}/month; new merchants and anything over $${policy.approval.require_above_usd} need your approval.`);
  if (authority === "base-sepolia") {
    out(`\nNext: approve this spend permission IN YOUR OWN WALLET (Paygent can't and never sees your wallet key):`);
    out({ contract: "0xf85210B21cC50302F477BA56686d2019dC9b67Ad (SpendPermissionManager, Base Sepolia)", permission });
    out(`Then run "paygent permission check". Spender address (needs a little Base Sepolia ETH for gas): ${spender}`);
  }
  out(`\nStart the daemon:   paygent start
Add to your agent (stdio, e.g. Claude Code / Claude Desktop / Cursor):
${JSON.stringify({ mcpServers: { paygent: { command: "npx", args: ["paygent", "mcp"], env: { PAYGENT_HOME: P.dir } } } }, null, 2)}
Or over HTTP: http://127.0.0.1:${config.mcp.port}/mcp with header "Authorization: Bearer <contents of ${P.mcpToken}>"`);
}

async function approveOrReject(id: string, decision: "approve" | "reject") {
  const p = await control("GET", `/payment?id=${encodeURIComponent(id)}`);
  out(`${decision.toUpperCase()} ${p.payment_id}\n  merchant: ${p.merchant}\n  amount:   $${p.amount_usd} (card cap $${p.card_cap_usd})\n  reasons:  ${p.approval.reasons.join(", ")}\n  agent's description (untrusted text): ${JSON.stringify(p.description)}`);
  if (p.approval.level === "hardware" && decision === "approve") {
    const exp = Math.floor(Date.now() / 1000) + 600;
    out(`\nThis payment needs your hardware / root wallet signature. Sign this EIP-712 message (eth_signTypedData_v4), then run:\n  paygent hw-submit ${id} ${exp} <signature>`);
    return out({ domain: hardwareApprovalDomain(84532), types: HARDWARE_APPROVAL_TYPES, primaryType: "PaygentApproval",
      message: { paymentId: p.payment_id, merchant: p.merchant, amountCents: String(Math.round(Number(p.amount_usd) * 100)), expiresAt: String(exp) } });
  }
  const key = await ownerKey();
  const payload: ApprovalPayload = { payment_id: p.payment_id, merchant: p.merchant, amount_cents: Math.round(Number(p.amount_usd) * 100), decision, expires_at: new Date(Date.now() + 5 * 60_000).toISOString() };
  out(await control("POST", "/decision", { payload, signature: signOwner(key, DOMAIN_APPROVAL, payload) }));
}

async function policyCmd(args: string[]) {
  const [sub, path, value] = args;
  const current = PolicySchema.parse(JSON.parse(readFileSync(P.policy, "utf8")));
  if (sub === "show" || !sub) return out(current);
  if (sub !== "set" || !path || value === undefined) die('usage: paygent policy set <dotted.path> <json value>, e.g. paygent policy set limits.daily_usd "\\"40.00\\""');
  const next = structuredClone(current) as Record<string, any>;
  const keys = path.split(".");
  let o = next;
  for (const k of keys.slice(0, -1)) { if (!(k in o)) die(`unknown policy path ${path}`); o = o[k]; }
  if (!(keys.at(-1)! in o)) die(`unknown policy path ${path}`);
  let v: unknown; try { v = JSON.parse(value); } catch { v = value; }
  const before = o[keys.at(-1)!];
  o[keys.at(-1)!] = v;
  const parsed = PolicySchema.parse(next);
  const loosens = looser(before, v, path);
  out(`${path}: ${JSON.stringify(before)} -> ${JSON.stringify(v)}${loosens ? "   (LOOSENS the policy)" : ""}`);
  if (loosens && (process.env.PAYGENT_CONFIRM ?? await ask('Type "loosen" to confirm')) !== "loosen") die("not changed");
  PolicyStore.write(P.policy, P.policySig, parsed, await ownerKey());
  try { out(await control("POST", "/reload-policy")); if (loosens) out("Note: a running daemon keeps the stricter of old and new limits until restarted."); }
  catch { out("Policy saved; the daemon isn't running."); }
}

/** True if changing `path` from `before` to `after` gives the agent more room. Unknown shapes count as loosening. */
function looser(before: unknown, after: unknown, path: string): boolean {
  const stricterWhenTrue = ["require_for_new_merchant", "allow_only_listed"];
  const shrinkingIsLooser = path.endsWith("deny") || path === "blocked_keywords";
  if (typeof before === "string" && typeof after === "string" && /^\d/.test(before)) return usdToCents(after) > usdToCents(before);
  if (typeof before === "number" && typeof after === "number") return after > before;
  if (typeof before === "boolean" && typeof after === "boolean") {
    return stricterWhenTrue.some((k) => path.endsWith(k)) ? before && !after : !before && after;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return shrinkingIsLooser ? before.some((x) => !after.includes(x)) : after.some((x) => !before.includes(x));
  }
  return true;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "setup": return setup(args);
    case "start": {
      const { startDaemon } = await import("./daemon.ts");
      await startDaemon(await secret("Daemon passphrase", "PAYGENT_DAEMON_PASSPHRASE"));
      return;
    }
    case "mcp": { const { runStdioBridge } = await import("./mcp/stdio-bridge.ts"); return runStdioBridge(); }
    case "status": return out(await control("GET", "/status"));
    case "pending": {
      const list = await control("GET", "/pending");
      if (list.length === 0) return out("No payments waiting for approval.");
      for (const p of list) out(`${p.payment_id}  $${p.amount_usd}  ${p.merchant}  [${p.approval.level}: ${p.approval.reasons.join(", ")}]  expires ${p.approval.expires_at}\n    agent's description (untrusted): ${JSON.stringify(p.description)}`);
      return;
    }
    case "approve": return approveOrReject(args[0] ?? die("usage: paygent approve <payment_id>"), "approve");
    case "reject": return approveOrReject(args[0] ?? die("usage: paygent reject <payment_id>"), "reject");
    case "hw-submit": {
      const [id, exp, sig] = args;
      if (!id || !exp || !sig) die("usage: paygent hw-submit <payment_id> <expires_unix> <signature>");
      const p = await control("GET", `/payment?id=${encodeURIComponent(id)}`);
      return out(await control("POST", "/hardware-approval", { payment_id: id, merchant: p.merchant, amount_cents: Math.round(Number(p.amount_usd) * 100), expires_at_unix: Number(exp), signature: sig }));
    }
    case "kill": {
      out("Kill switch: freezing Paygent, revoking the spend permission, freezing all open cards, sweeping the spender balance.");
      return out(await control("POST", "/kill"));
    }
    case "unfreeze": {
      const st = await control("GET", "/status");
      if (!st.frozen_at) return out("Not frozen.");
      return out(await control("POST", "/unfreeze", { signature: signOwner(await ownerKey(), DOMAIN_UNFREEZE, { frozen_at: st.frozen_at }) }));
    }
    case "reveal": {
      const id = args[0] ?? die("usage: paygent reveal <payment_id>");
      const p = await control("GET", `/payment?id=${encodeURIComponent(id)}`);
      const payload = { payment_id: id, merchant: p.merchant, amount_cents: Math.round(Number(p.amount_usd) * 100), decision: "reveal", expires_at: new Date(Date.now() + 60_000).toISOString() };
      const card = await control("POST", "/reveal", { payload, signature: signOwner(await ownerKey(), DOMAIN_APPROVAL, payload) });
      return out(`Card for ${card.merchant} (cap $${centsToUsd(card.cap_cents)}, single use)\n  number: ${card.number}\n  exp:    ${card.exp}\n  cvv:    ${card.cvv}\nClear your terminal after use.`);
    }
    case "topup": {
      if (args[0] === "status") return out(await control("GET", `/topup?id=${encodeURIComponent(args[1] ?? "")}`));
      const amount = usdToCents(args[0] ?? die("usage: paygent topup <usd> | paygent topup status <session>"));
      const payload = { payment_id: `topup-${Date.now()}`, merchant: "onramp", amount_cents: amount, decision: "topup", expires_at: new Date(Date.now() + 60_000).toISOString() };
      const s = await control("POST", "/topup", { payload, signature: signOwner(await ownerKey(), DOMAIN_APPROVAL, payload) });
      return out(`Open this on-ramp page in your browser to complete KYC and payment with the provider:\n  ${s.hostedUrl}\n(session ${s.providerSessionId}, expires ${s.expiresAt})`);
    }
    case "policy": return policyCmd(args);
    case "secrets": {
      if (args[0] !== "set" || !args[1]) die("usage: paygent secrets set <name>   e.g. lithic-sandbox.api_key");
      const pass = await secret("Daemon passphrase", "PAYGENT_DAEMON_PASSPHRASE");
      const ks = Keystore.open(P.keystore, pass);
      ks.update(P.keystore, pass, { [args[1]]: await secret(`Value for ${args[1]}`, "PAYGENT_SECRET_VALUE") });
      return out(`Saved ${args[1]}. Restart the daemon to use it.`);
    }
    case "audit": {
      if (args[0] === "verify") { const v = AuditLog.verify(P.audit); out(v); if (!v.ok) process.exit(2); return; }
      if (args[0] === "head") { const v = AuditLog.verify(P.audit); return out(v.ok ? { seq: v.count, hash: v.head } : v); }
      if (args[0] === "tail") return out(readFileSync(P.audit, "utf8").trim().split("\n").slice(-Number(args[1] ?? 20)).join("\n"));
      return die("usage: paygent audit verify|head|tail [n]");
    }
    case "permission": {
      const cfg = readConfig(P, readFileSync(P.ownerPub, "utf8"));
      if (!cfg.funding.permission) die("no on-chain permission configured (funding path or mock authority)");
      if (args[0] === "show" || !args[0]) return out(cfg.funding.permission);
      if (args[0] === "check") {
        const { createPublicClient, http: viemHttp } = await import("viem");
        const { baseSepolia } = await import("viem/chains");
        const { SPEND_PERMISSION_MANAGER, spendPermissionAbi, permissionFromJson } = await import("./authority/spend-permission.ts");
        const pub = createPublicClient({ chain: baseSepolia, transport: viemHttp(cfg.funding.rpc_url!) });
        const perm = permissionFromJson(cfg.funding.permission as any);
        const [approved, revoked] = await Promise.all([
          pub.readContract({ address: SPEND_PERMISSION_MANAGER, abi: spendPermissionAbi, functionName: "isApproved", args: [perm] }),
          pub.readContract({ address: SPEND_PERMISSION_MANAGER, abi: spendPermissionAbi, functionName: "isRevoked", args: [perm] }),
        ]);
        return out({ approved, revoked });
      }
      if (args[0] === "set-signature" && args[1]) {
        const key = await ownerKey();
        cfg.funding.permission = { ...cfg.funding.permission, signature: args[1] };
        writeConfig(P, cfg, key);
        return out("Saved. Paygent will submit it with approveWithSignature on first spend. Restart the daemon.");
      }
      return die("usage: paygent permission show|check|set-signature <sig>");
    }
    case "doctor": {
      const issues: string[] = [];
      const cfg = readConfig(P, readFileSync(P.ownerPub, "utf8"));
      const pol = PolicySchema.parse(JSON.parse(readFileSync(P.policy, "utf8")));
      if (!isLoopback(cfg.mcp.host)) issues.push(`MCP bound to ${cfg.mcp.host} (not loopback)`);
      if (pol.remote.enabled) issues.push("remote.enabled is true");
      if (pol.cards.allow_reveal_to_agent) issues.push("allow_reveal_to_agent is true: the agent can read card numbers");
      if (!pol.approval.require_for_new_merchant) issues.push("new merchants don't need approval");
      if (usdToCents(pol.limits.daily_usd) > 50000) issues.push(`daily cap is high ($${pol.limits.daily_usd})`);
      if (cfg.funding.path === "fiat_direct") issues.push("fiat_direct has no on-chain cap: set account-level limits in your issuer's own app too");
      if (!AuditLog.verify(P.audit).ok) issues.push("audit log failed verification");
      return out(issues.length ? issues.map((i) => `! ${i}`).join("\n") : "No issues found.");
    }
    default:
      out(`paygent <command>   (TEST MODE ONLY)
  setup [--funding fiat_direct|fiat_onramp|crypto_wallet] [--authority mock|base-sepolia] [--issuer mock|lithic-sandbox|<dir>]
  start                      run the daemon (MCP on 127.0.0.1:7402)
  mcp                        stdio bridge for agents that launch MCP servers
  status | pending | doctor
  approve <id> | reject <id> | hw-submit <id> <exp> <sig>
  reveal <id>                show a card to you (owner) in this terminal
  topup <usd> | topup status <session>       (fiat_onramp path)
  kill | unfreeze
  policy show | policy set <path> <value>
  permission show|check|set-signature <sig>  (base-sepolia)
  secrets set <name>
  audit verify | head | tail [n]`);
  }
}

main().catch((e) => die((e as Error).message));
