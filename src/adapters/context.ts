import { redact, redactString } from "../redact.ts";
import type { AdapterContext, AdapterLogger, AdapterManifest } from "./types.ts";

export function hostAllowed(url: string, allowedHosts: string[]): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  return allowedHosts.some((h) => u.hostname === h.toLowerCase());
}

export function restrictedFetch(manifest: AdapterManifest, baseFetch: typeof fetch = fetch) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (!hostAllowed(url, manifest.allowedHosts)) {
      throw new Error(`adapter ${manifest.id}: host not in allowedHosts: ${safeHost(url)}`);
    }
    // No redirects: a redirect could leave the allowlist.
    return baseFetch(url, { ...init, redirect: "error" });
  };
}

function safeHost(url: string) { try { return new URL(url).host; } catch { return "(invalid url)"; } }

export function adapterLogger(id: string, sink: (line: string) => void = (l) => process.stderr.write(l + "\n")): AdapterLogger {
  const emit = (level: string, msg: string, data?: Record<string, unknown>) =>
    sink(JSON.stringify({ level, adapter: id, msg: redactString(String(msg)).slice(0, 500), data: data ? redact(data) : undefined }));
  return { info: (m, d) => emit("info", m, d), warn: (m, d) => emit("warn", m, d) };
}

export function buildContext(manifest: AdapterManifest, opts: {
  config: AdapterContext["config"]; apiKey: string | null; fetchImpl?: typeof fetch; logSink?: (l: string) => void;
}): AdapterContext {
  return Object.freeze({
    config: Object.freeze({ ...opts.config }),
    apiKey: opts.apiKey,
    http: restrictedFetch(manifest, opts.fetchImpl),
    log: adapterLogger(manifest.id, opts.logSink),
    testMode: true as const,
  });
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function validateManifest(m: AdapterManifest): void {
  if (!ID_RE.test(m.id)) throw new Error("adapter id must match " + ID_RE);
  if (m.kind !== "issuer" && m.kind !== "onramp") throw new Error("adapter kind must be issuer or onramp");
  if (m.kind === "issuer" && (!Array.isArray(m.fundingModels) || m.fundingModels.length === 0)) {
    throw new Error("issuer adapters must declare fundingModels");
  }
  if (m.testModeOnly !== true) throw new Error("v0.1 adapters must declare testModeOnly: true");
  if (!Array.isArray(m.allowedHosts) || m.allowedHosts.some((h) => !/^[a-z0-9.-]+$/.test(h))) throw new Error("allowedHosts must be bare hostnames");
}
