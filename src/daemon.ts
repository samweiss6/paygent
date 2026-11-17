// paygentd: MCP over Streamable HTTP on loopback (agent plane) + owner control API on a Unix
// socket with mode 0600 (owner plane). Owner actions that increase authority (approve, unfreeze,
// reveal, top-up) need a signature from the owner key, which the daemon never holds.

import http from "node:http";
import https from "node:https";
import { readFileSync, existsSync, unlinkSync, chmodSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildRuntime, type Runtime } from "./runtime.ts";
import { paths as getPaths, isLoopback } from "./config.ts";
import { createMcpServer } from "./mcp/server.ts";
import { constantTimeEqual } from "./crypto/keystore.ts";
import { verifyOwner, DOMAIN_APPROVAL } from "./crypto/owner.ts";
import { PaymentError } from "./service.ts";
import { redact } from "./redact.ts";

const MAX_BODY = 64 * 1024;

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export function mcpHandler(rt: Runtime, token: string, allowedHosts: string[]) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/mcp") return send(res, 404, { error: "not found" });
      // DNS-rebinding protection: Host must be one we bound to; browsers' Origin must be absent or loopback.
      if (!allowedHosts.includes(String(req.headers.host ?? ""))) return send(res, 421, { error: "bad host" });
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return send(res, 403, { error: "bad origin" });
      const auth = String(req.headers.authorization ?? "");
      if (!auth.startsWith("Bearer ") || !constantTimeEqual(auth.slice(7), token)) {
        rt.audit.append("mcp_auth_failed", { remote: req.socket.remoteAddress ?? null });
        return send(res, 401, { error: "unauthorized" });
      }
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
      const body = await readBody(req);
      const server = createMcpServer({ service: rt.service, policy: rt.policy, audit: rt.audit });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) send(res, 400, { error: (e as Error).message });
    }
  };
}

export function controlHandler(rt: Runtime) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://control");
    const route = `${req.method} ${url.pathname}`;
    try {
      const body = (req.method === "POST" ? await readBody(req) : undefined) as Record<string, any> | undefined;
      switch (route) {
        case "GET /status": {
          const b = await rt.service.balance();
          return send(res, 200, { ...b, policy_valid: rt.policy.valid, policy_error: rt.policy.error, frozen_at: rt.service.frozenAt(),
            open: rt.ledger.listByStatus(["pending_approval", "approved", "funding", "issued"]).map((r) => ({ id: r.id, status: r.status, merchant: r.merchant, amount_cents: r.amount_cents })),
            audit_head: rt.audit.head, issuer: rt.config.issuer.id });
        }
        case "GET /pending": return send(res, 200, rt.service.listPending().map((p) => ({ ...p, description: rt.ledger.get(p.payment_id)?.description })));
        case "GET /payment": {
          const row = rt.ledger.get(url.searchParams.get("id") ?? "");
          if (!row) return send(res, 404, { error: "not found" });
          return send(res, 200, { ...rt.service.getPayment(row.id), description: row.description });
        }
        case "POST /decision": return send(res, 200, await rt.service.ownerDecision(body!.payload, body!.signature));
        case "POST /hardware-approval": return send(res, 200, await rt.service.hardwareApproval(body as any));
        case "POST /kill": return send(res, 200, await rt.service.kill("owner-cli"));
        case "POST /unfreeze": return send(res, 200, rt.service.unfreeze(body!.signature));
        case "POST /reload-policy": rt.policy.reload(); rt.audit.append("policy_reloaded", { valid: rt.policy.valid, error: rt.policy.error }); return send(res, 200, { valid: rt.policy.valid, error: rt.policy.error });
        case "POST /reveal": {
          // Owner-signed: { payment_id, merchant, amount_cents, decision: "reveal", expires_at }
          const { payload, signature } = body as { payload: any; signature: string };
          if (payload?.decision !== "reveal" || !verifyOwner(readFileSync(getPaths().ownerPub, "utf8"), DOMAIN_APPROVAL, payload, signature) || Date.parse(payload.expires_at) < Date.now()) {
            throw new PaymentError("bad_signature", "reveal needs a fresh owner signature");
          }
          const out = await rt.service.withCard(payload.payment_id, async (card, row) => ({ number: card.pan, cvv: card.cvv, exp: `${card.expMonth}/${card.expYear}`, cap_cents: row.cap_cents, merchant: row.merchant }));
          rt.audit.append("card_revealed_to_owner", { payment_id: payload.payment_id });
          return send(res, 200, out);
        }
        case "POST /topup": {
          if (!rt.topups) throw new PaymentError("invalid_state", "top-ups need funding.path = fiat_onramp");
          const { payload, signature } = body as { payload: any; signature: string };
          if (payload?.decision !== "topup" || !verifyOwner(readFileSync(getPaths().ownerPub, "utf8"), DOMAIN_APPROVAL, payload, signature) || Date.parse(payload.expires_at) < Date.now()) {
            throw new PaymentError("bad_signature", "top-up needs a fresh owner signature");
          }
          const s = await rt.topups.create(payload.amount_cents, payload.payment_id);
          rt.audit.append("topup_created", { session: s.providerSessionId, amount_cents: payload.amount_cents });
          return send(res, 200, s);
        }
        case "GET /topup": return send(res, 200, await rt.topups!.status(url.searchParams.get("id") ?? ""));
        default: return send(res, 404, { error: "unknown route" });
      }
    } catch (e) {
      const code = e instanceof PaymentError ? e.code : "error";
      return send(res, e instanceof PaymentError ? 400 : 500, { error: { code, message: (e as Error).message } });
    }
  };
}

export async function startDaemon(daemonPassphrase: string) {
  const p = getPaths();
  const rt = await buildRuntime(daemonPassphrase);
  const token = readFileSync(p.mcpToken, "utf8").trim();
  const { host, port, tls_cert, tls_key } = rt.config.mcp;

  if (!isLoopback(host)) {
    if (!rt.policy.policy?.remote.enabled) throw new Error(`refusing to bind MCP to ${host}: remote.enabled is false in the signed policy`);
    if (!tls_cert || !tls_key) throw new Error("remote MCP requires mcp.tls_cert and mcp.tls_key");
  }
  const hostHeaderNames = isLoopback(host) ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`] : [`${host}:${port}`];
  const handler = mcpHandler(rt, token, hostHeaderNames);
  // Inside a container, loopback is the container's own; listen on all container interfaces and
  // rely on docker-compose publishing the port to the HOST's loopback only. Host-header and bearer
  // checks still apply. Never set this outside a container.
  const listenHost = process.env.PAYGENT_CONTAINER === "1" && isLoopback(host) ? "0.0.0.0" : host;
  const mcp = tls_cert && tls_key
    ? https.createServer({ cert: readFileSync(tls_cert), key: readFileSync(tls_key) }, handler)
    : http.createServer(handler);
  await new Promise<void>((r) => mcp.listen(port, listenHost, r));

  if (existsSync(p.socket)) unlinkSync(p.socket);
  const control = http.createServer(controlHandler(rt));
  const oldMask = process.umask(0o177);
  await new Promise<void>((r) => control.listen(p.socket, r));
  process.umask(oldMask);
  chmodSync(p.socket, 0o600);

  const timer = setInterval(() => { rt.service.sweepOpenPayments().catch((e) => process.stderr.write(JSON.stringify(redact({ sweep_error: String(e) })) + "\n")); }, 30_000);
  timer.unref();

  process.stderr.write(`paygent: MCP on ${tls_cert ? "https" : "http"}://${host}:${port}/mcp (test mode, funding: ${rt.config.funding.path}, issuer: ${rt.config.issuer.id})\n`);
  process.stderr.write(`paygent: owner control socket ${p.socket}\n`);
  if (!rt.policy.valid) process.stderr.write(`paygent: WARNING policy invalid (${rt.policy.error}); all payments will be denied\n`);

  const shutdown = () => { clearInterval(timer); mcp.close(); control.close(); rt.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { rt, mcp, control, shutdown };
}
