// Runs a third-party adapter in a separate Node process under the permission model and exposes
// it to the core as a normal IssuerAdapter / OnrampAdapter. The child gets only its manifest,
// its own config, and its own API key. It cannot read the keystore, ledger, policy, or audit log.
//
// Known gap: Node's permission model does not restrict network access. Outbound hosts are
// enforced only by the restricted fetch the adapter is given; an adapter that opens raw sockets
// bypasses that. See docs/02-threat-model-and-policy.md, T3.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { validateManifest } from "./context.ts";
import type { AdapterManifest, IssuerAdapter, IssuerManifest, OnrampAdapter, OnrampManifest } from "./types.ts";

const SRC_ADAPTERS = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(SRC_ADAPTERS, "..");

export interface SandboxedAdapter { proxy: IssuerAdapter | OnrampAdapter; child: ChildProcess; close(): void }

export function readManifest(adapterDir: string): AdapterManifest {
  const m = JSON.parse(readFileSync(join(adapterDir, "paygent-adapter.json"), "utf8")) as AdapterManifest & { entry?: string };
  validateManifest(m);
  return m;
}

export async function startSandboxedAdapter(opts: {
  adapterDir: string; config: Record<string, string | number | boolean>; apiKey: string | null;
  timeoutMs?: number; onLog?: (line: string) => void;
}): Promise<SandboxedAdapter> {
  const dir = resolve(opts.adapterDir);
  const manifestRaw = JSON.parse(readFileSync(join(dir, "paygent-adapter.json"), "utf8")) as AdapterManifest & { entry: string };
  validateManifest(manifestRaw);
  const entry = resolve(dir, manifestRaw.entry);
  if (!entry.startsWith(dir + "/")) throw new Error("adapter entry must be inside the adapter directory");

  const child = spawn(process.execPath, [
    "--permission",
    `--allow-fs-read=${dir}`,
    `--allow-fs-read=${SRC_ADAPTERS}`,
    `--allow-fs-read=${join(SRC_ROOT, "redact.ts")}`,
    "--disable-proto=delete",
    join(SRC_ADAPTERS, "runner.ts"),
  ], { stdio: ["pipe", "pipe", "pipe"], env: { NODE_OPTIONS: "", PATH: "" }, cwd: dir });

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let msg: { id: number; result?: unknown; error?: string };
    try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new Error(`adapter ${manifestRaw.id}: ${msg.error}`)); else p.resolve(msg.result);
  });
  createInterface({ input: child.stderr! }).on("line", (l) => opts.onLog?.(l.slice(0, 2000)));
  child.on("exit", () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`adapter ${manifestRaw.id} exited`)); } pending.clear(); });

  const call = (method: string, params: unknown[]) => new Promise<unknown>((res, rej) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`adapter ${manifestRaw.id}: ${method} timed out`)); }, opts.timeoutMs ?? 30_000);
    pending.set(id, { resolve: res, reject: rej, timer });
    child.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
  });

  await call("init", [entry, manifestRaw, opts.config, opts.apiKey]);

  const proxy = manifestRaw.kind === "issuer"
    ? ({
        manifest: manifestRaw as IssuerManifest,
        createCard: (r) => call("createCard", [r]),
        freezeCard: (id) => call("freezeCard", [id]),
        getCardStatus: (id) => call("getCardStatus", [id]),
        simulateCharge: (id, a, d) => call("simulateCharge", [id, a, d]),
      } as IssuerAdapter)
    : ({
        manifest: manifestRaw as OnrampManifest,
        createTopUp: (r) => call("createTopUp", [r]),
        getTopUpStatus: (id) => call("getTopUpStatus", [id]),
        simulateComplete: (id) => call("simulateComplete", [id]),
      } as OnrampAdapter);

  return { proxy, child, close: () => child.kill() };
}
