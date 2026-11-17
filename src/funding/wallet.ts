// crypto_wallet and fiat_onramp funding. Both draw from the owner's smart wallet through the
// SpendPermission; the on-ramp path adds owner-initiated top-ups into that same wallet.

import { centsToUsdcUnits, usdcUnitsToCents } from "../money.ts";
import type { SpendAuthority } from "../authority/types.ts";
import type { OnrampAdapter, TopUpSession } from "../adapters/types.ts";
import { FundingError, type FundingBalance, type FundingPath, type FundingSource } from "./types.ts";

export class WalletFunding implements FundingSource {
  readonly feeds = "usdc_deposit" as const;
  readonly path: FundingPath;
  #auth: SpendAuthority;
  /** issuerId -> USDC deposit address; from signed config, never from the agent or an adapter. */
  #depositAddresses: Record<string, `0x${string}`>;

  constructor(auth: SpendAuthority, depositAddresses: Record<string, `0x${string}`>, path: "crypto_wallet" | "fiat_onramp" = "crypto_wallet") {
    this.#auth = auth;
    this.#depositAddresses = depositAddresses;
    this.path = path;
  }

  async balance(): Promise<FundingBalance> {
    const i = await this.#auth.info();
    const remaining = i.remainingUnits < i.ownerBalanceUnits ? i.remainingUnits : i.ownerBalanceUnits;
    return {
      path: this.path,
      externalLimit: {
        kind: "onchain_allowance",
        remainingCents: usdcUnitsToCents(i.remainingUnits),
        allowanceCents: usdcUnitsToCents(i.allowanceUnits),
        periodEndsAt: i.periodEndsAt,
        permissionEndsAt: i.permissionEndsAt,
        revoked: i.revoked,
      },
      availableCents: usdcUnitsToCents(remaining),
      notes: [`authority: ${i.mode}`, ...(i.mode === "mock" ? ["mock authority: no real funds"] : ["Base Sepolia testnet"])],
    };
  }

  async precheck(amountCents: number) {
    const i = await this.#auth.info();
    const units = centsToUsdcUnits(amountCents);
    if (i.revoked) throw new FundingError("revoked", "spend permission revoked");
    if (units > i.remainingUnits) throw new FundingError("insufficient_allowance", "on-chain allowance for this period is too low");
    if (units > i.ownerBalanceUnits) throw new FundingError("insufficient_funds", "wallet balance too low");
  }

  async fund(_paymentId: string, amountCents: number, issuerId: string) {
    const to = this.#depositAddresses[issuerId];
    if (!to) throw new FundingError("funding_failed", `no USDC deposit address configured for issuer ${issuerId}`);
    const units = centsToUsdcUnits(amountCents);
    const spent = await this.#auth.spend(units);
    try {
      const fwd = await this.#auth.forward(to, units);
      return { refs: [spent.ref, fwd.ref] };
    } catch (e) {
      // Forward failed after the pull: return the funds to the owner rather than leaving them at the spender.
      const sw = await this.#auth.sweep().catch(() => ({ ref: null }));
      throw new FundingError("funding_failed", `forward to issuer failed (${(e as Error).message}); swept back: ${sw.ref ?? "none"}`);
    }
  }

  async revoke() { return [(await this.#auth.revoke()).ref]; }

  async sweep() {
    const r = await this.#auth.sweep();
    return r.ref ? [r.ref] : [];
  }
}

/** Owner-only helper for the fiat_onramp path. Not reachable from MCP. */
export class OnrampTopUps {
  private adapter: OnrampAdapter;
  private ownerWallet: string;
  private asset: string;
  constructor(adapter: OnrampAdapter, ownerWallet: string, asset: string) {
    this.adapter = adapter; this.ownerWallet = ownerWallet; this.asset = asset;
  }

  create(amountCents: number, idempotencyKey: string): Promise<TopUpSession> {
    if (!Number.isSafeInteger(amountCents) || amountCents < 500) throw new Error("top-up must be at least $5.00");
    return this.adapter.createTopUp({ amountCents, destinationAddress: this.ownerWallet, asset: this.asset, idempotencyKey });
  }

  status(id: string) { return this.adapter.getTopUpStatus(id); }
}
