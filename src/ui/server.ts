// `paygent ui`: the owner's web dashboard. A separate process from the daemon, with the same
// trust as the CLI: it talks to the daemon over the 0600 control socket and decrypts the owner
// key only for the instant it signs an approval, unfreeze, or policy change.
//
// Who can use it:
//  - Reading (status, payments, audit) needs the launch token printed in the terminal.
//  - Anything that adds authority needs the owner passphrase in that request. An agent on the
//    same machine that finds the token still can't approve anything without the passphrase.
//  - The kill switch needs only the token: it can only take authority away.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths as getPaths } from "../config.ts";
import { constantTimeEqual } from "../crypto/keystore.ts";
import { controlRequest, ownerDecision, ownerUnfreeze, openOwnerKey } from "../owner-client.ts";
import { PolicySchema, type Policy } from "../policy/schema.ts";
import { PolicyStore } from "../policy/store.ts";
import { looser } from "../policy/diff.ts";
import { AuditLog } from "../audit.ts";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** Policy fields the dashboard may edit. Everything else stays CLI-only. */
export const EDITABLE_POLICY_PATHS = [
  "limits.per_transaction_usd", "limits.daily_usd", "limits.monthly_usd", "limits.per_merchant_daily_usd", "limits.max_payments_per_hour",
  "approval.require_for_new_merchant", "approval.require_above_usd", "approval.approval_ttl_minutes",
  "merchants.allow", "merchants.deny",
] as const;

const MAX_BODY = 16 * 1024;

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function getAt(obj: Record<string, any>, path: string) { return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj); }
function setAt(obj: Record<string, any>, path: string, v: unknown) {
  const keys = path.split("."); let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys.at(-1)!] = v;
}

export interface UiOptions { port: number; dir?: string; token?: string }

export function createUiServer(opts: UiOptions) {
  const P = getPaths(opts.dir);
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const hosts = [`127.0.0.1:${opts.port}`, `localhost:${opts.port}`];
  const origins = hosts.map((h) => `http://${h}`);
  const ctl = (m: "GET" | "POST", p: string, b?: unknown) => controlRequest(P.socket, m, p, b);

  // Passphrase attempts: 5 failures lock passphrase actions for 60 s.
  let failures = 0; let lockedUntil = 0;
  const withPassphrase = async <T>(passphrase: unknown, fn: (pass: string) => Promise<T>): Promise<T> => {
    if (Date.now() < lockedUntil) throw Object.assign(new Error(`too many wrong passphrases; try again in ${Math.ceil((lockedUntil - Date.now()) / 1000)} s`), { status: 429 });
    if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 1024) throw Object.assign(new Error("owner passphrase required"), { status: 400 });
    try {
      openOwnerKey(P.owner, passphrase); // check it first, even if the action turns out to be a no-op
      const r = await fn(passphrase);
      failures = 0;
      return r;
    } catch (e) {
      if (/wrong passphrase/.test((e as Error).message)) {
        failures++;
        if (failures >= 5) { lockedUntil = Date.now() + 60_000; failures = 0; }
        throw Object.assign(new Error("wrong owner passphrase"), { status: 403 });
      }
      throw e;
    }
  };

  const readPolicy = (): Policy => PolicySchema.parse(JSON.parse(readFileSync(P.policy, "utf8")));

  const auditTail = (n: number) => {
    if (!existsSync(P.audit)) return { verify: { ok: true, count: 0, head: "" }, entries: [] };
    const lines = readFileSync(P.audit, "utf8").trim().split("\n").filter(Boolean);
    return {
      verify: AuditLog.verify(P.audit),
      entries: lines.slice(-n).reverse().map((l) => { try { const e = JSON.parse(l); return { seq: e.seq, ts: e.ts, type: e.type, data: e.data }; } catch { return null; } }).filter(Boolean),
    };
  };

  const api: Record<string, (body: Record<string, unknown>, url: URL) => Promise<unknown>> = {
    "GET /api/overview": async () => {
      const [status, pending, payments] = await Promise.all([ctl("GET", "/status"), ctl("GET", "/pending"), ctl("GET", "/payments?limit=40")]);
      return { status, pending, payments, policy: readPolicy(), audit: auditTail(60), editable: EDITABLE_POLICY_PATHS };
    },
    "POST /api/decision": async (b) => {
      const decision = b.decision === "approve" ? "approve" : b.decision === "reject" ? "reject" : null;
      if (!decision || typeof b.payment_id !== "string") throw Object.assign(new Error("payment_id and decision required"), { status: 400 });
      return withPassphrase(b.passphrase, (pass) => ownerDecision(P.socket, P.owner, pass, b.payment_id as string, decision));
    },
    "POST /api/kill": async (b) => {
      if (b.confirm !== "kill") throw Object.assign(new Error("confirm required"), { status: 400 });
      return ctl("POST", "/kill");
    },
    "POST /api/unfreeze": async (b) => withPassphrase(b.passphrase, (pass) => ownerUnfreeze(P.socket, P.owner, pass)),
    "POST /api/policy": async (b) => {
      const changes = b.changes as Record<string, unknown> | undefined;
      if (!changes || typeof changes !== "object") throw Object.assign(new Error("changes required"), { status: 400 });
      const current = readPolicy();
      const next = structuredClone(current) as Record<string, any>;
      const diff: { path: string; before: unknown; after: unknown; loosens: boolean }[] = [];
      for (const [path, value] of Object.entries(changes)) {
        if (!(EDITABLE_POLICY_PATHS as readonly string[]).includes(path)) throw Object.assign(new Error(`${path} can't be changed from the dashboard; use the CLI`), { status: 400 });
        const before = getAt(next, path);
        if (JSON.stringify(before) === JSON.stringify(value)) continue;
        setAt(next, path, value);
        diff.push({ path, before, after: value, loosens: looser(before, value, path) });
      }
      const parsed = PolicySchema.safeParse(next);
      if (!parsed.success) throw Object.assign(new Error(`invalid policy: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`), { status: 400 });
      if (diff.length === 0) return { changed: [] };
      if (diff.some((d) => d.loosens) && b.confirm_loosen !== true) {
        return { needs_confirmation: true, diff };
      }
      return withPassphrase(b.passphrase, async (pass) => {
        PolicyStore.write(P.policy, P.policySig, parsed.data, openOwnerKey(P.owner, pass));
        const reload = await ctl("POST", "/reload-policy").catch(() => null);
        return { changed: diff, reload, note: diff.some((d) => d.loosens) ? "The running daemon keeps the stricter of the old and new limits until it restarts." : null };
      });
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!hosts.includes(String(req.headers.host ?? ""))) return send(res, 421, { error: "bad host" });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const origin = req.headers.origin;
      if (origin && !origins.includes(origin)) return send(res, 403, { error: "bad origin" });

      if (req.method === "GET" && STATIC[url.pathname]) {
        const s = STATIC[url.pathname];
        return send(res, 200, readFileSync(join(PUBLIC, s.file)), s.type);
      }
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });

      // Custom header: a cross-site page can't send it without a CORS preflight, which we never answer.
      const t = String(req.headers["x-paygent-token"] ?? "");
      if (!t || !constantTimeEqual(t, token)) return send(res, 401, { error: "missing or wrong dashboard token; reopen the link printed by `paygent ui`" });
      if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "JSON only" });

      const handler = api[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { error: "not found" });
      const body = req.method === "POST" ? await readJson(req) : {};
      return send(res, 200, await handler(body, url));
    } catch (e) {
      const status = (e as { status?: number }).status ?? 502;
      return send(res, status, { error: (e as Error).message });
    }
  });

  return { server, token, url: `http://127.0.0.1:${opts.port}/#token=${token}` };
}

export async function startUi(port: number) {
  const ui = createUiServer({ port });
  await new Promise<void>((resolve, reject) => { ui.server.once("error", reject); ui.server.listen(port, "127.0.0.1", resolve); });
  process.stdout.write(`Paygent dashboard (test mode): ${ui.url}\n`);
  process.stdout.write(`Open it in a browser your agent does not control. Anyone with this link can view activity and use the kill switch; approvals also need your owner passphrase.\n`);
  const stop = () => { ui.server.close(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  return ui;
}
