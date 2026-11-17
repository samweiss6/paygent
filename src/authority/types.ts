// Spend authority: the narrow, revocable on-chain allowance the owner granted.

export interface AllowanceInfo {
  mode: "mock" | "base-sepolia";
  /** Remaining allowance in the current period, USDC base units (6 decimals). */
  remainingUnits: bigint;
  allowanceUnits: bigint;
  periodEndsAt: string;       // ISO
  permissionEndsAt: string;   // ISO
  ownerBalanceUnits: bigint;  // USDC in the owner's smart wallet
  spenderBalanceUnits: bigint;
  revoked: boolean;
}

export interface SpendAuthority {
  readonly mode: AllowanceInfo["mode"];
  info(): Promise<AllowanceInfo>;
  /** Pull exactly `units` from the owner's wallet to the spender via the allowance. */
  spend(units: bigint): Promise<{ ref: string }>;
  /** Move USDC from the spender to a destination fixed in signed config (never agent-supplied). */
  forward(to: `0x${string}`, units: bigint): Promise<{ ref: string }>;
  /** Return any spender balance to the owner's wallet. */
  sweep(): Promise<{ ref: string | null; units: bigint }>;
  /** Kill switch: revoke the allowance from the spender side. */
  revoke(): Promise<{ ref: string }>;
}
