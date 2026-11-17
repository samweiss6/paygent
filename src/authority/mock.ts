// In-process stand-in for SpendPermissionManager with the same semantics: a per-period allowance,
// start/end, revocation. Used for dry runs and tests. Never moves real money. State persists to a
// JSON file so a restart doesn't reset the allowance.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AllowanceInfo, SpendAuthority } from "./types.ts";

interface MockState {
  allowanceUnits: string;
  periodSeconds: number;
  start: number;
  end: number;
  ownerBalanceUnits: string;
  spenderBalanceUnits: string;
  periodStart: number;
  periodSpent: string;
  revoked: boolean;
  forwarded: Record<string, string>;
}

export class MockAuthority implements SpendAuthority {
  readonly mode = "mock" as const;
  #path: string | null;
  #s: MockState;
  #now: () => number;

  constructor(opts: { statePath: string | null; allowanceUnits: bigint; periodSeconds?: number; durationDays?: number;
                      ownerBalanceUnits?: bigint; now?: () => number }) {
    this.#path = opts.statePath;
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    if (this.#path && existsSync(this.#path)) {
      this.#s = JSON.parse(readFileSync(this.#path, "utf8"));
    } else {
      const t = this.#now();
      this.#s = {
        allowanceUnits: opts.allowanceUnits.toString(),
        periodSeconds: opts.periodSeconds ?? 86400,
        start: t,
        end: t + (opts.durationDays ?? 30) * 86400,
        ownerBalanceUnits: (opts.ownerBalanceUnits ?? 1_000_000_000n).toString(), // 1,000 test USDC
        spenderBalanceUnits: "0",
        periodStart: t,
        periodSpent: "0",
        revoked: false,
        forwarded: {},
      };
      this.#save();
    }
  }

  #save() { if (this.#path) writeFileSync(this.#path, JSON.stringify(this.#s, null, 2), { mode: 0o600 }); }

  #roll() {
    const t = this.#now();
    while (t >= this.#s.periodStart + this.#s.periodSeconds) {
      this.#s.periodStart += this.#s.periodSeconds;
      this.#s.periodSpent = "0";
    }
  }

  async info(): Promise<AllowanceInfo> {
    this.#roll();
    const allowance = BigInt(this.#s.allowanceUnits);
    const live = !this.#s.revoked && this.#now() < this.#s.end;
    return {
      mode: "mock",
      remainingUnits: live ? allowance - BigInt(this.#s.periodSpent) : 0n,
      allowanceUnits: allowance,
      periodEndsAt: new Date((this.#s.periodStart + this.#s.periodSeconds) * 1000).toISOString(),
      permissionEndsAt: new Date(this.#s.end * 1000).toISOString(),
      ownerBalanceUnits: BigInt(this.#s.ownerBalanceUnits),
      spenderBalanceUnits: BigInt(this.#s.spenderBalanceUnits),
      revoked: this.#s.revoked,
    };
  }

  async spend(units: bigint) {
    this.#roll();
    // Same checks the contract performs; these are the L1 backstop in mock mode.
    if (this.#s.revoked) throw new Error("SpendPermissionManager: revoked");
    if (this.#now() >= this.#s.end) throw new Error("SpendPermissionManager: after end");
    if (units <= 0n) throw new Error("SpendPermissionManager: zero value");
    const spent = BigInt(this.#s.periodSpent) + units;
    if (spent > BigInt(this.#s.allowanceUnits)) throw new Error("SpendPermissionManager: exceeded allowance");
    if (units > BigInt(this.#s.ownerBalanceUnits)) throw new Error("ERC20: insufficient balance");
    this.#s.periodSpent = spent.toString();
    this.#s.ownerBalanceUnits = (BigInt(this.#s.ownerBalanceUnits) - units).toString();
    this.#s.spenderBalanceUnits = (BigInt(this.#s.spenderBalanceUnits) + units).toString();
    this.#save();
    return { ref: `mock-spend-${randomUUID()}` };
  }

  async forward(to: `0x${string}`, units: bigint) {
    if (units > BigInt(this.#s.spenderBalanceUnits)) throw new Error("ERC20: insufficient spender balance");
    this.#s.spenderBalanceUnits = (BigInt(this.#s.spenderBalanceUnits) - units).toString();
    this.#s.forwarded[to] = (BigInt(this.#s.forwarded[to] ?? "0") + units).toString();
    this.#save();
    return { ref: `mock-forward-${randomUUID()}` };
  }

  async sweep() {
    const units = BigInt(this.#s.spenderBalanceUnits);
    if (units === 0n) return { ref: null, units };
    this.#s.ownerBalanceUnits = (BigInt(this.#s.ownerBalanceUnits) + units).toString();
    this.#s.spenderBalanceUnits = "0";
    this.#save();
    return { ref: `mock-sweep-${randomUUID()}`, units };
  }

  /** Mock on-ramp delivery: credit the owner's wallet. */
  credit(units: bigint) {
    this.#s.ownerBalanceUnits = (BigInt(this.#s.ownerBalanceUnits) + units).toString();
    this.#save();
  }

  async revoke() {
    this.#s.revoked = true;
    this.#save();
    return { ref: `mock-revoke-${randomUUID()}` };
  }
}
