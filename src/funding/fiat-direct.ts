// fiat_direct: the issuer charges the owner's bank account or debit card that the owner linked
// inside their own provider account. Paygent moves no money; the card's cap and single-use
// controls (set by the issuer) and Paygent's policy are the limits.
//
// Important difference from the wallet paths: there is no limit outside Paygent and the issuer
// that a compromised host can't raise. Whoever holds the issuer API key can create cards up to
// what the provider allows. Owners should set account-level limits in the provider's own app
// where the provider offers them. See docs/02-threat-model-and-policy.md, T7.

import type { FundingBalance, FundingSource } from "./types.ts";

export class FiatDirectFunding implements FundingSource {
  readonly path = "fiat_direct" as const;
  readonly feeds = "fiat_linked" as const;

  private opts: { issuerId: string; providerAccountLimitCents?: number | null };
  constructor(opts: { issuerId: string; providerAccountLimitCents?: number | null }) { this.opts = opts; }

  async balance(): Promise<FundingBalance> {
    return {
      path: "fiat_direct",
      externalLimit: null,
      availableCents: this.opts.providerAccountLimitCents ?? null,
      notes: [
        `cards are funded by the bank account or debit card linked in your ${this.opts.issuerId} account`,
        "no on-chain limit applies on this path; Paygent policy and issuer card controls are the limits",
      ],
    };
  }

  async precheck(_amountCents: number) { /* nothing to check locally; the issuer declines if unfunded */ }

  async fund(paymentId: string) { return { refs: [`issuer-funded:${paymentId}`] }; }

  async revoke() { return []; }  // nothing on-chain; the kill switch freezes cards instead

  async sweep() { return []; }
}
