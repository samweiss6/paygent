import { z } from "zod";
import { usdToCents } from "../money.ts";

const usd = z.string().refine((s) => { try { usdToCents(s); return true; } catch { return false; } }, "invalid USD amount");

export const PolicySchema = z.strictObject({
  version: z.literal(1),
  limits: z.strictObject({
    per_transaction_usd: usd,
    daily_usd: usd,
    monthly_usd: usd,
    max_payments_per_hour: z.int().min(1).max(1000),
    per_merchant_daily_usd: usd,
  }),
  approval: z.strictObject({
    require_for_new_merchant: z.boolean(),
    require_above_usd: usd,
    hardware_required_above_usd: usd,
    hardware_signer_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable(),
    approval_ttl_minutes: z.int().min(1).max(24 * 60),
  }),
  merchants: z.strictObject({
    allow: z.array(z.string().max(253)).max(1000),
    deny: z.array(z.string().max(253)).max(10000),
    allow_only_listed: z.boolean(),
  }),
  blocked_keywords: z.array(z.string().min(1).max(64)).max(1000),
  cards: z.strictObject({
    max_lifetime_minutes: z.int().min(5).max(24 * 60),
    amount_tolerance_percent: z.number().min(0).max(25),
    amount_tolerance_max_usd: usd,
    allow_reveal_to_agent: z.boolean(),
  }),
  remote: z.strictObject({ enabled: z.boolean() }),
});

export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  version: 1,
  limits: {
    per_transaction_usd: "25.00",
    daily_usd: "50.00",
    monthly_usd: "200.00",
    max_payments_per_hour: 5,
    per_merchant_daily_usd: "50.00",
  },
  approval: {
    require_for_new_merchant: true,
    require_above_usd: "10.00",
    hardware_required_above_usd: "100.00",
    hardware_signer_address: null,
    approval_ttl_minutes: 30,
  },
  merchants: {
    allow: [],
    deny: [
      "giftcards.com", "giftcardmall.com", "raise.com", "cardcash.com",
      "coinbase.com", "binance.com", "binance.us", "kraken.com", "crypto.com", "moonpay.com",
      "paypal.com", "venmo.com", "cash.app", "westernunion.com", "moneygram.com", "remitly.com", "wise.com",
      "draftkings.com", "fanduel.com", "stake.com",
    ],
    allow_only_listed: false,
  },
  blocked_keywords: [
    "gift card", "giftcard", "prepaid card", "prepaid visa", "reload", "crypto", "bitcoin", "usdt",
    "wire transfer", "money order", "money transfer", "casino", "betting", "sportsbook",
  ],
  cards: {
    max_lifetime_minutes: 60,
    amount_tolerance_percent: 5,
    amount_tolerance_max_usd: "2.00",
    allow_reveal_to_agent: false,
  },
  remote: { enabled: false },
};

/** Card cap for an approved amount: amount + min(tolerance%, tolerance max). */
export function cardCapCents(policy: Policy, amountCents: number): number {
  const pct = Math.floor((amountCents * policy.cards.amount_tolerance_percent) / 100);
  return amountCents + Math.min(pct, usdToCents(policy.cards.amount_tolerance_max_usd));
}

/**
 * Combine two policies taking the stricter value of every limit. Used when a policy
 * reload races a decision, so a reload can never loosen an in-flight decision.
 */
export function stricterOf(a: Policy, b: Policy): Policy {
  const minUsd = (x: string, y: string) => (usdToCents(x) <= usdToCents(y) ? x : y);
  return {
    version: 1,
    limits: {
      per_transaction_usd: minUsd(a.limits.per_transaction_usd, b.limits.per_transaction_usd),
      daily_usd: minUsd(a.limits.daily_usd, b.limits.daily_usd),
      monthly_usd: minUsd(a.limits.monthly_usd, b.limits.monthly_usd),
      max_payments_per_hour: Math.min(a.limits.max_payments_per_hour, b.limits.max_payments_per_hour),
      per_merchant_daily_usd: minUsd(a.limits.per_merchant_daily_usd, b.limits.per_merchant_daily_usd),
    },
    approval: {
      require_for_new_merchant: a.approval.require_for_new_merchant || b.approval.require_for_new_merchant,
      require_above_usd: minUsd(a.approval.require_above_usd, b.approval.require_above_usd),
      hardware_required_above_usd: minUsd(a.approval.hardware_required_above_usd, b.approval.hardware_required_above_usd),
      hardware_signer_address: a.approval.hardware_signer_address ?? b.approval.hardware_signer_address,
      approval_ttl_minutes: Math.min(a.approval.approval_ttl_minutes, b.approval.approval_ttl_minutes),
    },
    merchants: {
      allow: a.merchants.allow.filter((m) => b.merchants.allow.includes(m)),
      deny: [...new Set([...a.merchants.deny, ...b.merchants.deny])],
      allow_only_listed: a.merchants.allow_only_listed || b.merchants.allow_only_listed,
    },
    blocked_keywords: [...new Set([...a.blocked_keywords, ...b.blocked_keywords])],
    cards: {
      max_lifetime_minutes: Math.min(a.cards.max_lifetime_minutes, b.cards.max_lifetime_minutes),
      amount_tolerance_percent: Math.min(a.cards.amount_tolerance_percent, b.cards.amount_tolerance_percent),
      amount_tolerance_max_usd: minUsd(a.cards.amount_tolerance_max_usd, b.cards.amount_tolerance_max_usd),
      allow_reveal_to_agent: a.cards.allow_reveal_to_agent && b.cards.allow_reveal_to_agent,
    },
    remote: { enabled: a.remote.enabled && b.remote.enabled },
  };
}
