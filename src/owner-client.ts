// Owner-side client for the daemon's control socket, shared by the CLI and the web UI.
// Runs in the owner's process, never in the daemon. The owner key is decrypted here only for
// the moment it takes to sign, then dropped.

import http from "node:http";
import { Keystore } from "./crypto/keystore.ts";
import { signOwner, DOMAIN_APPROVAL, DOMAIN_UNFREEZE, type ApprovalPayload } from "./crypto/owner.ts";

export function controlRequest(socketPath: string, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method, headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let data: any = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* keep {} */ }
        if ((res.statusCode ?? 500) >= 400) reject(new Error(data.error?.message ?? data.error ?? `HTTP ${res.statusCode}`)); else resolve(data);
      });
    });
    req.on("error", (e: NodeJS.ErrnoException) => reject(new Error(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? `daemon not running (no socket at ${socketPath}); run "paygent start"` : e.message)));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

export function openOwnerKey(ownerKeystorePath: string, passphrase: string): string {
  return Keystore.open(ownerKeystorePath, passphrase).require("owner_private_key_pem");
}

export function approvalFor(p: { payment_id: string; merchant: string; amount_usd: string }, decision: ApprovalPayload["decision"], ttlMs = 5 * 60_000): ApprovalPayload {
  return {
    payment_id: p.payment_id, merchant: p.merchant, amount_cents: Math.round(Number(p.amount_usd) * 100), decision,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };
}

export async function ownerDecision(socketPath: string, ownerKeystorePath: string, passphrase: string, paymentId: string, decision: "approve" | "reject") {
  const p = await controlRequest(socketPath, "GET", `/payment?id=${encodeURIComponent(paymentId)}`);
  if (p.approval?.level === "hardware" && decision === "approve") {
    throw new Error("this payment needs your hardware wallet signature; use `paygent approve` in a terminal");
  }
  const key = openOwnerKey(ownerKeystorePath, passphrase);
  const payload = approvalFor(p, decision);
  return controlRequest(socketPath, "POST", "/decision", { payload, signature: signOwner(key, DOMAIN_APPROVAL, payload) });
}

export async function ownerUnfreeze(socketPath: string, ownerKeystorePath: string, passphrase: string) {
  const st = await controlRequest(socketPath, "GET", "/status");
  if (!st.frozen_at) return { frozen: false };
  const key = openOwnerKey(ownerKeystorePath, passphrase);
  return controlRequest(socketPath, "POST", "/unfreeze", { signature: signOwner(key, DOMAIN_UNFREEZE, { frozen_at: st.frozen_at }) });
}
