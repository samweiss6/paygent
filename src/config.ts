// Install configuration. Security-relevant (funding destinations, issuer choice), so it is signed
// with the owner key like the policy, and the daemon refuses to start if the signature is bad.

import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { signOwner, verifyOwner } from "./crypto/owner.ts";

export const DOMAIN_CONFIG = "paygent/config/v1";

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const ConfigSchema = z.strictObject({
  version: z.literal(1),
  funding: z.strictObject({
    path: z.enum(["crypto_wallet", "fiat_onramp", "fiat_direct"]),
    authority: z.enum(["mock", "base-sepolia"]).nullable(),
    rpc_url: z.string().url().nullable(),
    permission: z.record(z.string(), z.unknown()).nullable(),
    owner_wallet: addr.nullable(),
    issuer_deposit_addresses: z.record(z.string(), addr),
    onramp: z.string().nullable(),
  }),
  issuer: z.strictObject({
    id: z.string(),
    external_dir: z.string().nullable(),
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }),
  mcp: z.strictObject({
    host: z.string(),
    port: z.int().min(1).max(65535),
    tls_cert: z.string().nullable(),
    tls_key: z.string().nullable(),
  }),
  hardware_chain_id: z.int(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function dataDir(): string {
  return process.env.PAYGENT_HOME ?? join(homedir(), ".paygent");
}

export function paths(dir = dataDir()) {
  return {
    dir,
    config: join(dir, "config.json"),
    configSig: join(dir, "config.sig"),
    policy: join(dir, "policy.json"),
    policySig: join(dir, "policy.sig"),
    keystore: join(dir, "keystore.json"),
    owner: join(dir, "owner.json"),
    ownerPub: join(dir, "owner.pub"),
    ledger: join(dir, "ledger.db"),
    audit: join(dir, "audit.log"),
    mockChain: join(dir, "mock-chain.json"),
    socket: join(dir, "control.sock"),
    mcpToken: join(dir, "mcp-token"),
    adapters: join(dir, "adapters"),
  };
}

export function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function writeConfig(p: ReturnType<typeof paths>, cfg: Config, ownerPrivateKeyPem: string) {
  const parsed = ConfigSchema.parse(cfg);
  writeFileSync(p.config + ".tmp", JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(p.configSig + ".tmp", signOwner(ownerPrivateKeyPem, DOMAIN_CONFIG, parsed) + "\n", { mode: 0o600 });
  renameSync(p.config + ".tmp", p.config);
  renameSync(p.configSig + ".tmp", p.configSig);
}

export function readConfig(p: ReturnType<typeof paths>, ownerPublicKeyPem: string): Config {
  if (!existsSync(p.config)) throw new Error(`no config at ${p.config}; run "paygent setup"`);
  const raw = JSON.parse(readFileSync(p.config, "utf8"));
  const sig = existsSync(p.configSig) ? readFileSync(p.configSig, "utf8").trim() : "";
  if (!verifyOwner(ownerPublicKeyPem, DOMAIN_CONFIG, raw, sig)) throw new Error("config.json signature invalid: refusing to start");
  return ConfigSchema.parse(raw);
}

export const isLoopback = (h: string) => ["127.0.0.1", "::1", "localhost"].includes(h);
