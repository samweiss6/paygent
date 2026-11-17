// Pure policy decision function. No I/O: everything it needs is passed in.
// Spec: docs/02-threat-model-and-policy.md, section B.3.

import { usdToCents } from "../money.ts";
import { merchantMatches } from "../merchant.ts";
import type { Policy } from "./schema.ts";

export type DenyReason =
  | "frozen"
  | "invalid_request"
  | "merchant_denied"
  | "blocked_category"
  | "merchant_not_allowed"
  | "exceeds_per_transaction_limit"
  | "velocity_limit"
  | "exceeds_daily_limit"
  | "exceeds_monthly_limit"
  | "exceeds_merchant_daily_limit";

export type ApprovalReason = "new_merchant" | "above_approval_threshold" | "above_hardware_threshold";

export interface DecisionInput {
  merchant: string;          // already normalized by normalizeMerchant()
  amountCents: number;       // what the agent asked for; used for per-transaction and approval thresholds
  capCents: number;          // amount + tolerance; what gets reserved and counted against caps
  description: string;
}

/** Aggregates the ledger computes inside the same transaction as the reservation. */
export interface LedgerView {
  frozen: boolean;
  policyValid: boolean;
  dayCommittedCents: number;          // reserved + settled, current UTC day
  monthCommittedCents: number;        // reserved + settled, current UTC month
  merchantDayCommittedCents: number;  // same, for this merchant
  paymentsLastHour: number;           // created in the last hour, any status except denied
  merchantKnown: boolean;             // a previous payment to this merchant was approved by owner or settled
}

export type Decision =
  | { outcome: "deny"; reason: DenyReason }
  | { outcome: "approve"; approvalLevel: "none" }
  | { outcome: "require_approval"; approvalLevel: "owner" | "hardware"; reasons: ApprovalReason[] };

export const MAX_DESCRIPTION = 280;
const MAX_AMOUNT_CENTS = 100_000_000;

export function decide(input: DecisionInput, policy: Policy, view: LedgerView): Decision {
  if (view.frozen || !view.policyValid) return { outcome: "deny", reason: "frozen" };

  const { merchant, amountCents, capCents, description } = input;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS ||
      !Number.isSafeInteger(capCents) || capCents < amountCents) {
    return { outcome: "deny", reason: "invalid_request" };
  }
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION) {
    return { outcome: "deny", reason: "invalid_request" };
  }

  if (policy.merchants.deny.some((p) => merchantMatches(merchant, p))) {
    return { outcome: "deny", reason: "merchant_denied" };
  }

  const haystack = `${merchant} ${description}`.toLowerCase().replace(/[\s_-]+/g, " ");
  const squashed = haystack.replace(/ /g, "");
  if (policy.blocked_keywords.some((k) => {
    const kw = k.toLowerCase().replace(/[\s_-]+/g, " ");
    return haystack.includes(kw) || squashed.includes(kw.replace(/ /g, ""));
  })) {
    return { outcome: "deny", reason: "blocked_category" };
  }

  const allowed = policy.merchants.allow.some((p) => merchantMatches(merchant, p));
  if (policy.merchants.allow_only_listed && !allowed) {
    return { outcome: "deny", reason: "merchant_not_allowed" };
  }

  const L = policy.limits;
  if (amountCents > usdToCents(L.per_transaction_usd)) return { outcome: "deny", reason: "exceeds_per_transaction_limit" };
  if (view.paymentsLastHour >= L.max_payments_per_hour) return { outcome: "deny", reason: "velocity_limit" };
  if (view.dayCommittedCents + capCents > usdToCents(L.daily_usd)) return { outcome: "deny", reason: "exceeds_daily_limit" };
  if (view.monthCommittedCents + capCents > usdToCents(L.monthly_usd)) return { outcome: "deny", reason: "exceeds_monthly_limit" };
  if (view.merchantDayCommittedCents + capCents > usdToCents(L.per_merchant_daily_usd)) {
    return { outcome: "deny", reason: "exceeds_merchant_daily_limit" };
  }

  const A = policy.approval;
  if (amountCents > usdToCents(A.hardware_required_above_usd)) {
    return { outcome: "require_approval", approvalLevel: "hardware", reasons: ["above_hardware_threshold"] };
  }
  const reasons: ApprovalReason[] = [];
  if (A.require_for_new_merchant && !view.merchantKnown && !allowed) reasons.push("new_merchant");
  if (amountCents > usdToCents(A.require_above_usd)) reasons.push("above_approval_threshold");
  if (reasons.length > 0) return { outcome: "require_approval", approvalLevel: "owner", reasons };
  return { outcome: "approve", approvalLevel: "none" };
}
