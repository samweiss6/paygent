// Child-process entry point for third-party adapters. Started by host.ts with Node's permission
// model: filesystem reads limited to the adapter's directory and Paygent's src/adapters + redact,
// no writes, no child processes, no workers, no native addons.
// Protocol: newline-delimited JSON over stdin/stdout. stderr carries redacted adapter logs.

import { createInterface } from "node:readline";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { buildContext, validateManifest } from "./context.ts";
import type { AdapterManifest, IssuerAdapter, OnrampAdapter } from "./types.ts";

type Adapter = IssuerAdapter | OnrampAdapter;

// Modules an adapter must not load: they would let it open connections outside ctx.http,
// start processes, or inspect this process. Node's permission model already blocks child
// processes, workers, and addons; this closes the network gap the permission model leaves.
const BLOCKED_MODULES = new Set([
  "net", "tls", "http", "https", "http2", "dgram", "dns", "dns/promises", "undici",
  "child_process", "cluster", "worker_threads", "inspector", "inspector/promises", "v8", "vm", "wasi", "trace_events",
]);

function lockDownNetwork() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const bare = specifier.replace(/^node:/, "");
      if (BLOCKED_MODULES.has(bare)) {
        throw Object.assign(new Error(`adapter sandbox: module "${specifier}" is not allowed; use ctx.http`), { code: "ERR_PAYGENT_BLOCKED_MODULE" });
      }
      return nextResolve(specifier, context);
    },
  });
  // Network-capable globals. (Request/Response/Headers are inert without fetch and stay.)
  for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) {
    try { delete (globalThis as Record<string, unknown>)[name]; } catch { /* non-configurable */ }
  }
  const proc = process as unknown as Record<string, unknown>;
  // process.getBuiltinModule() loads built-ins without going through resolve hooks.
  const realGet = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.bind(process);
  if (realGet) {
    (process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule = (id: string) => {
      if (BLOCKED_MODULES.has(id.replace(/^node:/, ""))) throw Object.assign(new Error(`adapter sandbox: module "${id}" is not allowed`), { code: "ERR_PAYGENT_BLOCKED_MODULE" });
      return realGet(id);
    };
  }
  for (const name of ["binding", "_linkedBinding", "dlopen"]) {
    try { proc[name] = () => { throw Object.assign(new Error(`adapter sandbox: process.${name} is not allowed`), { code: "ERR_PAYGENT_BLOCKED" }); }; } catch { /* ignore */ }
  }
}

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
      // Build the context first: ctx.http captures the real fetch before it is removed below.
      const ctx = buildContext(manifest, { config, apiKey, logSink: (l) => process.stderr.write(l + "\n") });
      lockDownNetwork();
      const mod = await import(pathToFileURL(modulePath).href);
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
    reply(msg.id, { error: String((e as Error)?.message ?? e).slice(0, 2000) });
  }
});
