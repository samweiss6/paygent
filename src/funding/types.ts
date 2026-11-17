// Funding sources live in the core (they may hold the spender key), unlike adapters.
// The agent-facing API is identical for all three paths; only get_balance reports which is active.
//
//   crypto_wallet : owner's smart wallet (USDC) -> SpendPermission -> issuer USDC deposit -> card
//   fiat_onramp   : owner's bank/debit -> on-ramp (owner top-up) -> owner's smart wallet -> same as above
//   fiat_direct   : owner's bank/debit linked inside the issuer account -> card (no crypto)

import type { FundingModel } from "../adapters/types.ts";

export type FundingPath = "crypto_wallet" | "fiat_onramp" | "fiat_direct";

export interface FundingBalance {
  path: FundingPath;
  /** Hard limit enforced outside Paygent, if any: on-chain allowance, or null for fiat_direct. */
  externalLimit: null | { kind: "onchain_allowance"; remainingCents: number; allowanceCents: number; periodEndsAt: string; permissionEndsAt: string; revoked: boolean };
  /** Funds available to draw on, if known. null when the provider doesn't report it. */
  availableCents: number | null;
  notes: string[];
}

export interface FundingResult {
  /** Reference for the audit log: tx hashes, or "issuer-funded" for fiat_direct. */
  refs: string[];
}

export interface FundingSource {
  readonly path: FundingPath;
  /** Which issuer funding model this source can feed. */
  readonly feeds: FundingModel;
  balance(): Promise<FundingBalance>;
  /** Check headroom without moving anything. Throws an Error with code "insufficient_funds" if not enough. */
  precheck(amountCents: number): Promise<void>;
  /** Move funds for one payment. Must be safe to call once per payment (the service guarantees once). */
  fund(paymentId: string, amountCents: number, issuerId: string): Promise<FundingResult>;
  /** Kill switch: revoke external authority if any. Returns refs for the audit log. */
  revoke(): Promise<string[]>;
  /** Return stray balances to the owner, if any. */
  sweep(): Promise<string[]>;
}

export class FundingError extends Error {
  readonly code: "insufficient_funds" | "insufficient_allowance" | "revoked" | "funding_failed";
  constructor(code: FundingError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
