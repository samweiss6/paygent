// Builds the running core from config + unlocked keystore.

import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { paths as getPaths, readConfig, type Config } from "./config.ts";
import { Keystore } from "./crypto/keystore.ts";
import { Ledger } from "./ledger.ts";
import { AuditLog } from "./audit.ts";
import { PolicyStore } from "./policy/store.ts";
import { CardVault } from "./vault.ts";
import { PaymentService } from "./service.ts";
import { MockAuthority } from "./authority/mock.ts";
import { SpendPermissionAuthority, type SpendPermissionJson } from "./authority/spend-permission.ts";
import type { SpendAuthority } from "./authority/types.ts";
import { WalletFunding, OnrampTopUps } from "./funding/wallet.ts";
import { FiatDirectFunding } from "./funding/fiat-direct.ts";
import type { FundingSource } from "./funding/types.ts";
import { buildContext } from "./adapters/context.ts";
import { createMockIssuer, mockIssuerManifest } from "./adapters/builtin/mock-issuer.ts";
import { createLithicSandbox, lithicSandboxManifest } from "./adapters/builtin/lithic-sandbox.ts";
import { createMockOnramp, mockOnrampManifest } from "./adapters/builtin/mock-onramp.ts";
import { startSandboxedAdapter } from "./adapters/host.ts";
import type { IssuerAdapter } from "./adapters/types.ts";
import { centsToUsdcUnits, usdToCents } from "./money.ts";
import { DEFAULT_POLICY } from "./policy/schema.ts";

export interface Runtime {
  config: Config;
  keystore: Keystore;
  ledger: Ledger;
  audit: AuditLog;
  policy: PolicyStore;
  service: PaymentService;
  topups: OnrampTopUps | null;
  close(): void;
}

export async function buildRuntime(daemonPassphrase: string, dir?: string): Promise<Runtime> {
  const p = getPaths(dir);
  const ownerPub = readFileSync(p.ownerPub, "utf8");
  const config = readConfig(p, ownerPub);
  const keystore = Keystore.open(p.keystore, daemonPassphrase);
  const ledger = new Ledger(p.ledger);
  const audit = new AuditLog(p.audit);
  const policy = new PolicyStore(p.policy, p.policySig, ownerPub);
  const closers: (() => void)[] = [() => ledger.close()];

  // Issuer
  let issuer: IssuerAdapter;
  const issuerKey = keystore.get(`${config.issuer.id}.api_key`) ?? null;
  if (config.issuer.id === "mock") {
    issuer = createMockIssuer(buildContext(mockIssuerManifest, { config: config.issuer.config, apiKey: null }));
  } else if (config.issuer.id === "lithic-sandbox") {
    issuer = createLithicSandbox(buildContext(lithicSandboxManifest, { config: config.issuer.config, apiKey: issuerKey }));
  } else if (config.issuer.external_dir) {
    const sb = await startSandboxedAdapter({ adapterDir: config.issuer.external_dir, config: config.issuer.config, apiKey: issuerKey,
      onLog: (l) => process.stderr.write(l + "\n") });
    issuer = sb.proxy as IssuerAdapter;
    if (issuer.manifest.kind !== "issuer") throw new Error("configured issuer adapter is not an issuer");
    closers.push(() => sb.close());
  } else {
    throw new Error(`unknown issuer ${config.issuer.id}`);
  }

  // Funding
  let funding: FundingSource;
  let topups: OnrampTopUps | null = null;
  const f = config.funding;
  if (f.path === "fiat_direct") {
    funding = new FiatDirectFunding({ issuerId: config.issuer.id });
  } else {
    let authority: SpendAuthority;
    if (f.authority === "base-sepolia") {
      if (!f.permission || !f.rpc_url) throw new Error("base-sepolia authority needs funding.permission and funding.rpc_url");
      authority = new SpendPermissionAuthority({
        permission: f.permission as unknown as SpendPermissionJson,
        spenderPrivateKey: keystore.require("spender_private_key") as Hex,
        rpcUrl: f.rpc_url,
      });
    } else {
      authority = new MockAuthority({ statePath: p.mockChain, allowanceUnits: centsToUsdcUnits(usdToCents(policy.policy?.limits.daily_usd ?? DEFAULT_POLICY.limits.daily_usd)) });
    }
    funding = new WalletFunding(authority, f.issuer_deposit_addresses as Record<string, `0x${string}`>, f.path);
    if (f.path === "fiat_onramp") {
      if (f.onramp !== "mock-onramp") throw new Error(`on-ramp ${f.onramp} not available in v0.1 (only mock-onramp)`);
      if (!f.owner_wallet) throw new Error("fiat_onramp needs funding.owner_wallet");
      const onramp = createMockOnramp(buildContext(mockOnrampManifest, { config: {}, apiKey: null }), (_to, units) => {
        if (authority instanceof MockAuthority) authority.credit(units);
      });
      topups = new OnrampTopUps(onramp, f.owner_wallet, f.authority === "base-sepolia" ? "USDC:base-sepolia" : "USDC:mock");
    }
  }

  const vault = new CardVault(ledger, keystore.require("vault_key"));
  const service = new PaymentService({ ledger, audit, policy, funding, issuer, vault, ownerPublicKeyPem: ownerPub, hardwareChainId: config.hardware_chain_id });
  audit.append("daemon_started", { funding_path: f.path, authority: f.authority, issuer: config.issuer.id, policy_valid: policy.valid, policy_error: policy.error });
  return { config, keystore, ledger, audit, policy, service, topups, close: () => closers.forEach((c) => c()) };
}
