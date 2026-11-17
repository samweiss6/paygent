// Child-process entry point for third-party adapters. Started by host.ts with Node's permission
// model: filesystem reads limited to the adapter's directory and Paygent's src/adapters + redact,
// no writes, no child processes, no workers, no native addons.
// Protocol: newline-delimited JSON over stdin/stdout. stderr carries redacted adapter logs.

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { buildContext, validateManifest } from "./context.ts";
import type { AdapterManifest, IssuerAdapter, OnrampAdapter } from "./types.ts";

type Adapter = IssuerAdapter | OnrampAdapter;
let adapter: Adapter | null = null;

const ISSUER_METHODS = new Set(["createCard", "freezeCard", "getCardStatus", "simulateCharge"]);
const ONRAMP_METHODS = new Set(["createTopUp", "getTopUpStatus", "simulateComplete"]);

function reply(id: number, body: { result?: unknown; error?: string }) {
  process.stdout.write(JSON.stringify({ id, ...body }) + "\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg: { id: number; method: string; params: unknown[] };
  try { msg = JSON.parse(line); } catch { return; }
  try {
    if (msg.method === "init") {
      const [modulePath, manifest, config, apiKey] = msg.params as [string, AdapterManifest, Record<string, string | number | boolean>, string | null];
      validateManifest(manifest);
      const mod = await import(pathToFileURL(modulePath).href);
      const ctx = buildContext(manifest, { config, apiKey, logSink: (l) => process.stderr.write(l + "\n") });
      adapter = mod.default(ctx) as Adapter;
      if (adapter.manifest.id !== manifest.id || adapter.manifest.kind !== manifest.kind) throw new Error("adapter manifest does not match installed manifest");
      return reply(msg.id, { result: { ok: true } });
    }
    if (!adapter) throw new Error("not initialized");
    const allowed = adapter.manifest.kind === "issuer" ? ISSUER_METHODS : ONRAMP_METHODS;
    if (!allowed.has(msg.method)) throw new Error(`method not allowed: ${msg.method}`);
    const fn = (adapter as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[msg.method];
    if (typeof fn !== "function") throw new Error(`adapter does not implement ${msg.method}`);
    reply(msg.id, { result: (await fn.apply(adapter, msg.params)) ?? null });
  } catch (e) {
    reply(msg.id, { error: String((e as Error)?.message ?? e).slice(0, 500) });
  }
});
