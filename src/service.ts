// Payment orchestrator. One payment: validate -> decide+reserve -> (approve) -> fund -> issue -> checkout -> settle.
// Agent-facing methods return PublicPayment, which never contains card secrets.

import { createHash, randomUUID } from "node:crypto";
import { centsToUsd, usdToCents } from "./money.ts";
import { normalizeMerchant, MerchantError } from "./merchant.ts";
import { decide, MAX_DESCRIPTION, type DenyReason } from "./policy/engine.ts";
import { cardCapCents, type Policy } from "./policy/schema.ts";
import type { PolicyStore } from "./policy/store.ts";
import type { Ledger, PaymentRow } from "./ledger.ts";
import type { AuditLog } from "./audit.ts";
import type { CardVault, CardSecret } from "./vault.ts";
import type { IssuerAdapter } from "./adapters/types.ts";
import { FundingError, type FundingSource } from "./funding/types.ts";
import {
  DOMAIN_APPROVAL, DOMAIN_UNFREEZE, verifyOwner, verifyHardwareApproval, type ApprovalPayload,
} from "./crypto/owner.ts";
import type { Hex } from "viem";

export interface PaymentRequestInput {
  merchant: string;
  amount_usd: string;
  description: string;
  idempotency_key: string;
}

export interface PublicPayment {
  payment_id: string;
  status: PaymentRow["status"];
  merchant: string;
  amount_usd: string;
  card_cap_usd: string;
  approval: { required: boolean; level: PaymentRow["approval_level"]; reasons: string[]; expires_at: string | null };
  deny_reason: string | null;
  card: { last4: string; expires_at: string } | null;
  funding_path: FundingSource["path"];
  next_step: string;
  test_mode: true;
}

export class PaymentError extends Error {
  readonly code: "idempotency_conflict" | "not_found" | "invalid_state" | "bad_signature" | "invalid_request";
  constructor(code: PaymentError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ServiceDeps {
  ledger: Ledger;
  audit: AuditLog;
  policy: PolicyStore;
  funding: FundingSource;
  issuer: IssuerAdapter;
  vault: CardVault;
  ownerPublicKeyPem: string;
  hardwareChainId: number;
  now?: () => Date;
}

const IDEM_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export class PaymentService {
  #d: ServiceDeps;
  #now: () => Date;

  constructor(deps: ServiceDeps) {
    this.#d = deps;
    this.#now = deps.now ?? (() => new Date());
    const im = deps.issuer.manifest;
    if (!im.fundingModels.includes(deps.funding.feeds)) {
      throw new Error(`issuer ${im.id} does not support funding model ${deps.funding.feeds} (path ${deps.funding.path})`);
    }
  }

  get fundingPath() { return this.#d.funding.path; }

  #policyOrThrow(): Policy | null {
    return this.#d.policy.valid ? this.#d.policy.policy : null;
  }

  // ---------- agent-facing ----------

  async requestPayment(input: PaymentRequestInput): Promise<PublicPayment> {
    const now = this.#now();
    const { ledger, audit } = this.#d;
    if (typeof input.idempotency_key !== "string" || !IDEM_RE.test(input.idempotency_key)) {
      throw new PaymentError("invalid_request", "idempotency_key must be 8-128 chars of [A-Za-z0-9_.:-]");
    }
    const requestHash = createHash("sha256")
      .update(JSON.stringify([input.merchant, input.amount_usd, input.description])).digest("hex");

    const existing = ledger.getByIdempotencyKey(input.idempotency_key);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        audit.append("idempotency_conflict", { payment_id: existing.id });
        throw new PaymentError("idempotency_conflict", "idempotency_key was already used with different parameters");
      }
      return this.#public(existing);
    }

    let merchant: string;
    let amountCents: number;
    try {
      merchant = normalizeMerchant(input.merchant);
      amountCents = usdToCents(input.amount_usd);
      if (typeof input.description !== "string" || input.description.length > MAX_DESCRIPTION) throw new Error("description too long");
    } catch (e) {
      audit.append("request_rejected", { reason: "invalid_request", detail: e instanceof MerchantError ? e.message : "invalid amount or description" });
      throw new PaymentError("invalid_request", e instanceof MerchantError ? e.message : (e as Error).message);
    }
    const description = input.description.replace(/[\u0000-\u001f\u007f]/g, " ");

    const policy = this.#policyOrThrow();
    const id = `pay_${randomUUID()}`;

    // Decision and reservation in one synchronous transaction: no interleaving between requests.
    const row = ledger.tx(() => {
      const view = ledger.view(merchant, now, policy !== null);
      const capCents = policy ? cardCapCents(policy, amountCents) : amountCents;
      const decision = policy
        ? decide({ merchant, amountCents, capCents, description }, policy, view)
        : { outcome: "deny" as const, reason: "frozen" as DenyReason };

      let status: PaymentRow["status"] = "denied";
      let level: PaymentRow["approval_level"] = "none";
      let reasons: string[] = [];
      let denyReason: string | null = null;
      if (decision.outcome === "deny") {
        denyReason = decision.reason;
      } else if (decision.outcome === "require_approval") {
        if (decision.approvalLevel === "hardware" && !policy!.approval.hardware_signer_address) {
          denyReason = "hardware_signer_not_configured";
        } else {
          status = "pending_approval"; level = decision.approvalLevel; reasons = decision.reasons;
        }
      } else {
        status = "approved";
      }

      const r: PaymentRow = {
        id, idempotency_key: input.idempotency_key, request_hash: requestHash, merchant, amount_cents: amountCents,
        cap_cents: capCents, description, status, approval_level: level, approval_reasons: JSON.stringify(reasons),
        deny_reason: denyReason, owner_approved: 0, issuer_id: this.#d.issuer.manifest.id, provider_card_id: null,
        last4: null, card_expires_at: null, funding_ref: null, settled_cents: null, error: null,
        created_at: now.toISOString(), updated_at: now.toISOString(),
        approval_expires_at: status === "pending_approval"
          ? new Date(now.getTime() + policy!.approval.approval_ttl_minutes * 60_000).toISOString() : null,
      };
      ledger.insert(r);
      return r;
    });

    audit.append("payment_requested", {
      payment_id: id, merchant, amount_cents: amountCents, cap_cents: row.cap_cents,
      description, status: row.status, deny_reason: row.deny_reason, approval_level: row.approval_level,
      approval_reasons: JSON.parse(row.approval_reasons), funding_path: this.#d.funding.path,
    });

    if (row.status === "approved") return this.#public(await this.#execute(id));
    return this.#public(row);
  }

  getPayment(id: string): PublicPayment {
    const row = this.#d.ledger.get(id);
    if (!row) throw new PaymentError("not_found", "no such payment");
    return this.#public(row);
  }

  async refresh(id: string): Promise<PublicPayment> {
    const row = this.#d.ledger.get(id);
    if (!row) throw new PaymentError("not_found", "no such payment");
    await this.#refreshRow(row);
    return this.getPayment(id);
  }

  async cancel(id: string, by: "agent" | "owner"): Promise<PublicPayment> {
    const now = this.#now();
    const row = this.#d.ledger.get(id);
    if (!row) throw new PaymentError("not_found", "no such payment");
    if (row.status === "issued" && row.provider_card_id) {
      await this.#d.issuer.freezeCard(row.provider_card_id);
    }
    if (!this.#d.ledger.transition(id, ["pending_approval", "approved", "issued"], "cancelled", now)) {
      throw new PaymentError("invalid_state", `cannot cancel a payment in status ${row.status}`);
    }
    this.#d.vault.wipe(id);
    this.#d.audit.append("payment_cancelled", { payment_id: id, by });
    return this.getPayment(id);
  }

  /** For the checkout injector and owner reveal only. Never exposed through MCP output. */
  async withCard<T>(id: string, fn: (card: CardSecret, row: PaymentRow) => Promise<T>): Promise<T> {
    const row = this.#d.ledger.get(id);
    if (!row) throw new PaymentError("not_found", "no such payment");
    if (this.#d.ledger.isFrozen()) throw new PaymentError("invalid_state", "paygent is frozen");
    if (row.status !== "issued") throw new PaymentError("invalid_state", `card not available in status ${row.status}`);
    if (row.card_expires_at && Date.parse(row.card_expires_at) < this.#now().getTime()) {
      await this.#expire(row);
      throw new PaymentError("invalid_state", "card expired");
    }
    const card = this.#d.vault.open(id);
    if (!card) throw new PaymentError("invalid_state", "card details no longer stored");
    return fn(card, row);
  }

  async balance() {
    const now = this.#now();
    const policy = this.#d.policy.policy;
    const view = this.#d.ledger.view("", now, this.#d.policy.valid);
    const funding = await this.#d.funding.balance();
    const lim = policy?.limits;
    return {
      frozen: view.frozen || !this.#d.policy.valid,
      funding,
      policy_remaining: lim ? {
        today_usd: centsToUsd(Math.max(0, usdToCents(lim.daily_usd) - view.dayCommittedCents)),
        this_month_usd: centsToUsd(Math.max(0, usdToCents(lim.monthly_usd) - view.monthCommittedCents)),
        per_transaction_max_usd: lim.per_transaction_usd,
      } : null,
      test_mode: true as const,
    };
  }

  // ---------- owner-facing (control plane only) ----------

  listPending(): PublicPayment[] {
    this.expireStaleApprovals();
    return this.#d.ledger.listByStatus(["pending_approval"]).map((r) => this.#public(r));
  }

  async ownerDecision(payload: ApprovalPayload, signatureB64: string): Promise<PublicPayment> {
    const now = this.#now();
    if (!verifyOwner(this.#d.ownerPublicKeyPem, DOMAIN_APPROVAL, payload, signatureB64)) {
      this.#d.audit.append("approval_rejected", { payment_id: payload.payment_id, reason: "bad_signature" });
      throw new PaymentError("bad_signature", "approval signature invalid");
    }
    const row = this.#checkApprovalTarget(payload.payment_id, payload.merchant, payload.amount_cents, Date.parse(payload.expires_at), now);
    if (payload.decision === "reject") return this.#reject(row, "owner");
    if (row.approval_level !== "owner") {
      this.#d.audit.append("approval_rejected", { payment_id: row.id, reason: "hardware_required" });
      throw new PaymentError("bad_signature", "this payment needs a hardware signer approval");
    }
    return this.#approve(row, "owner");
  }

  async hardwareApproval(args: { payment_id: string; merchant: string; amount_cents: number; expires_at_unix: number; signature: Hex }) {
    const now = this.#now();
    const policy = this.#d.policy.policy;
    const signer = policy?.approval.hardware_signer_address as Hex | null | undefined;
    if (!signer) throw new PaymentError("bad_signature", "no hardware signer configured");
    const row = this.#checkApprovalTarget(args.payment_id, args.merchant, args.amount_cents, args.expires_at_unix * 1000, now);
    const ok = await verifyHardwareApproval({
      signer, chainId: this.#d.hardwareChainId, signature: args.signature,
      paymentId: args.payment_id, merchant: args.merchant, amountCents: args.amount_cents, expiresAtUnix: args.expires_at_unix,
    });
    if (!ok) {
      this.#d.audit.append("approval_rejected", { payment_id: row.id, reason: "bad_hardware_signature" });
      throw new PaymentError("bad_signature", "hardware signature invalid");
    }
    return this.#approve(row, "hardware");
  }

  #checkApprovalTarget(id: string, merchant: string, amountCents: number, expiresAtMs: number, now: Date): PaymentRow {
    const row = this.#d.ledger.get(id);
    if (!row) throw new PaymentError("not_found", "no such payment");
    if (row.merchant !== merchant || row.amount_cents !== amountCents) {
      this.#d.audit.append("approval_rejected", { payment_id: id, reason: "approval_does_not_match_payment" });
      throw new PaymentError("bad_signature", "approval does not match this payment");
    }
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < now.getTime()) throw new PaymentError("bad_signature", "approval expired");
    if (row.status !== "pending_approval") throw new PaymentError("invalid_state", `payment is ${row.status}`);
    if (row.approval_expires_at && Date.parse(row.approval_expires_at) < now.getTime()) {
      this.expireStaleApprovals();
      throw new PaymentError("invalid_state", "approval window passed");
    }
    return row;
  }

  async #approve(row: PaymentRow, by: "owner" | "hardware") {
    const now = this.#now();
    if (!this.#d.ledger.transition(row.id, ["pending_approval"], "approved", now, { owner_approved: 1 })) {
      throw new PaymentError("invalid_state", "payment changed state");
    }
    this.#d.audit.append("payment_approved", { payment_id: row.id, by });
    return this.#public(await this.#execute(row.id));
  }

  #reject(row: PaymentRow, by: string) {
    this.#d.ledger.transition(row.id, ["pending_approval"], "rejected", this.#now());
    this.#d.audit.append("payment_rejected", { payment_id: row.id, by });
    return this.getPayment(row.id);
  }

  expireStaleApprovals() {
    const now = this.#now();
    for (const r of this.#d.ledger.listByStatus(["pending_approval"])) {
      if (r.approval_expires_at && Date.parse(r.approval_expires_at) < now.getTime()) {
        if (this.#d.ledger.transition(r.id, ["pending_approval"], "expired", now)) {
          this.#d.audit.append("approval_expired", { payment_id: r.id });
        }
      }
    }
  }

  /** Kill switch. Step 1 (freeze) is local and synchronous, so nothing can race it. */
  async kill(by: string) {
    const now = this.#now();
    const { ledger, audit } = this.#d;
    ledger.setMeta("frozen", "1");
    ledger.setMeta("frozen_at", now.toISOString());
    audit.append("kill_switch_engaged", { by });
    const result: Record<string, unknown> = { frozen: true };
    try { result.revoke_refs = await this.#d.funding.revoke(); } catch (e) { result.revoke_error = (e as Error).message; }
    const frozenCards: string[] = [];
    const errors: string[] = [];
    for (const r of ledger.listByStatus(["issued", "funding"])) {
      if (r.provider_card_id) {
        try { await this.#d.issuer.freezeCard(r.provider_card_id); frozenCards.push(r.id); }
        catch (e) { errors.push(`${r.id}: ${(e as Error).message}`); }
      }
      ledger.transition(r.id, ["issued", "funding"], "cancelled", now, { error: "kill switch" });
      this.#d.vault.wipe(r.id);
    }
    for (const r of ledger.listByStatus(["pending_approval", "approved"])) {
      ledger.transition(r.id, ["pending_approval", "approved"], "cancelled", now, { error: "kill switch" });
    }
    try { result.sweep_refs = await this.#d.funding.sweep(); } catch (e) { result.sweep_error = (e as Error).message; }
    result.frozen_cards = frozenCards;
    if (errors.length) result.freeze_errors = errors;
    audit.append("kill_switch_completed", result);
    return result;
  }

  unfreeze(signatureB64: string) {
    const frozenAt = this.#d.ledger.getMeta("frozen_at");
    if (!this.#d.ledger.isFrozen() || !frozenAt) return { frozen: false };
    if (!verifyOwner(this.#d.ownerPublicKeyPem, DOMAIN_UNFREEZE, { frozen_at: frozenAt }, signatureB64)) {
      throw new PaymentError("bad_signature", "unfreeze signature invalid");
    }
    this.#d.ledger.setMeta("frozen", "0");
    this.#d.audit.append("unfrozen", { frozen_at: frozenAt, note: "on-chain permission stays revoked; grant a new one to resume wallet funding" });
    return { frozen: false };
  }

  frozenAt() { return this.#d.ledger.getMeta("frozen_at") ?? null; }

  /** Poll issuer state for open payments; expire unused cards. */
  async sweepOpenPayments() {
    this.expireStaleApprovals();
    for (const r of this.#d.ledger.listByStatus(["issued"])) await this.#refreshRow(r).catch(() => {});
  }

  // ---------- internals ----------

  async #execute(id: string): Promise<PaymentRow> {
    const now = this.#now();
    const { ledger, audit, funding, issuer, vault } = this.#d;
    if (ledger.isFrozen()) {
      ledger.transition(id, ["approved"], "cancelled", now, { error: "frozen" });
      return ledger.get(id)!;
    }
    if (!ledger.transition(id, ["approved"], "funding", now)) return ledger.get(id)!;
    const row = ledger.get(id)!;
    const policy = this.#d.policy.policy!;

    try {
      await funding.precheck(row.cap_cents);
    } catch (e) {
      const code = e instanceof FundingError ? e.code : "funding_failed";
      ledger.transition(id, ["funding"], "denied", now, { deny_reason: code, error: (e as Error).message });
      audit.append("payment_denied_at_funding", { payment_id: id, reason: code });
      return ledger.get(id)!;
    }

    let fundingRefs: string[];
    try {
      fundingRefs = (await funding.fund(id, row.cap_cents, issuer.manifest.id)).refs;
    } catch (e) {
      ledger.transition(id, ["funding"], "failed", now, { error: `funding: ${(e as Error).message}` });
      audit.append("payment_failed", { payment_id: id, stage: "funding", error: (e as Error).message });
      return ledger.get(id)!;
    }
    audit.append("payment_funded", { payment_id: id, refs: fundingRefs, cap_cents: row.cap_cents });

    const expiresAt = new Date(now.getTime() + policy.cards.max_lifetime_minutes * 60_000).toISOString();
    let card;
    try {
      card = await issuer.createCard({
        amountCents: row.cap_cents, merchant: row.merchant, expiresAt, idempotencyKey: id,
        memo: `paygent ${id.slice(4, 12)} ${row.merchant}`.slice(0, 60),
      });
    } catch (e) {
      ledger.transition(id, ["funding"], "failed", now, { funding_ref: fundingRefs.join(","), error: `issuer: ${(e as Error).message}` });
      audit.append("payment_failed", { payment_id: id, stage: "issue", error: (e as Error).message,
        note: funding.path === "fiat_direct" ? null : "funds were delivered to the issuer deposit address and remain in the owner's issuer account" });
      return ledger.get(id)!;
    }

    // Don't trust the adapter's claims: verify the controls we asked for are the ones it set.
    const problems: string[] = [];
    if (!card.controls.singleUse) problems.push("card is not single-use");
    if (card.controls.capCents === null || card.controls.capCents > row.cap_cents) problems.push("card cap missing or too high");
    if (!/^\d{4}$/.test(card.last4) || card.pan.slice(-4) !== card.last4) problems.push("last4 mismatch");
    if (problems.length > 0) {
      await issuer.freezeCard(card.providerCardId).catch(() => {});
      ledger.transition(id, ["funding"], "failed", now, { provider_card_id: card.providerCardId, error: `card controls: ${problems.join("; ")}` });
      audit.append("card_controls_rejected", { payment_id: id, provider_card_id: card.providerCardId, problems });
      return ledger.get(id)!;
    }

    vault.put(id, { pan: card.pan, cvv: card.cvv, expMonth: card.expMonth, expYear: card.expYear });
    ledger.transition(id, ["funding"], "issued", now, {
      provider_card_id: card.providerCardId, last4: card.last4, card_expires_at: expiresAt, funding_ref: fundingRefs.join(","),
    });
    audit.append("card_issued", { payment_id: id, provider_card_id: card.providerCardId, last4: card.last4, cap_cents: row.cap_cents, expires_at: expiresAt });
    return ledger.get(id)!;
  }

  async #refreshRow(row: PaymentRow) {
    if (row.status !== "issued" || !row.provider_card_id) return;
    const now = this.#now();
    const st = await this.#d.issuer.getCardStatus(row.provider_card_id);
    const settled = st.transactions.find((t) => t.status === "settled");
    if (settled) {
      if (settled.amountCents > row.cap_cents) {
        this.#d.audit.append("settlement_over_cap", { payment_id: row.id, settled_cents: settled.amountCents, cap_cents: row.cap_cents });
      }
      if (this.#d.ledger.transition(row.id, ["issued"], "settled", now, { settled_cents: settled.amountCents })) {
        this.#d.vault.wipe(row.id);
        this.#d.audit.append("payment_settled", { payment_id: row.id, settled_cents: settled.amountCents, merchant_descriptor: settled.merchantDescriptor.slice(0, 80) });
      }
      return;
    }
    if (st.transactions.some((t) => t.status === "declined")) {
      this.#d.audit.append("card_decline_seen", { payment_id: row.id });
    }
    if (row.card_expires_at && Date.parse(row.card_expires_at) < now.getTime()) await this.#expire(row);
  }

  async #expire(row: PaymentRow) {
    if (row.provider_card_id) await this.#d.issuer.freezeCard(row.provider_card_id).catch(() => {});
    if (this.#d.ledger.transition(row.id, ["issued"], "expired", this.#now())) {
      this.#d.vault.wipe(row.id);
      this.#d.audit.append("card_expired_unused", { payment_id: row.id });
    }
  }

  #public(r: PaymentRow): PublicPayment {
    const nextStep: Record<string, string> = {
      denied: "Payment denied by policy. Do not retry with a different amount or merchant to get around it; ask the user.",
      pending_approval: "Waiting for the owner to approve. Poll get_payment_status; do not proceed until status is issued.",
      rejected: "The owner rejected this payment.",
      approved: "Approved; funding in progress. Poll get_payment_status.",
      funding: "Funding in progress. Poll get_payment_status.",
      issued: "Card issued. Call checkout_fill with the merchant's checkout page open in your browser, or ask the owner to pay with `paygent reveal`.",
      settled: "Payment settled.",
      declined: "The merchant charge was declined.",
      cancelled: "Payment cancelled.",
      expired: "Expired before use.",
      failed: "Payment failed. Ask the owner to check `paygent status`.",
    };
    return {
      payment_id: r.id,
      status: r.status,
      merchant: r.merchant,
      amount_usd: centsToUsd(r.amount_cents),
      card_cap_usd: centsToUsd(r.cap_cents),
      approval: {
        required: r.approval_level !== "none",
        level: r.approval_level,
        reasons: JSON.parse(r.approval_reasons),
        expires_at: r.status === "pending_approval" ? r.approval_expires_at : null,
      },
      deny_reason: r.deny_reason,
      card: r.last4 ? { last4: r.last4, expires_at: r.card_expires_at ?? "" } : null,
      funding_path: this.#d.funding.path,
      next_step: nextStep[r.status] ?? "",
      test_mode: true,
    };
  }
}
