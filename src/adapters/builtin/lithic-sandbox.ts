// Lithic sandbox issuer adapter. Sandbox only: the host allowlist contains sandbox.lithic.com and
// nothing else, so this adapter cannot reach production even with a live key.
// API reference: https://docs.lithic.com (cards, simulate). Auth header format follows Lithic's
// documented `Authorization: <api key>`; confirm against current docs (see provider comparison §7).

import type { AdapterContext, IssuerManifest, CardStatus, IssuerAdapter } from "../types.ts";

export const lithicSandboxManifest: IssuerManifest = {
  id: "lithic-sandbox",
  kind: "issuer",
  // Lithic cards draw on the program's funding account (fiat). In sandbox nothing moves.
  fundingModels: ["fiat_linked"],
  displayName: "Lithic (sandbox)",
  version: "0.1.0",
  allowedHosts: ["sandbox.lithic.com"],
  capabilities: { singleUse: true, merchantLock: "first_use", perCardCap: true, expiry: true, freeze: true },
  testModeOnly: true,
};

const BASE = "https://sandbox.lithic.com/v1";

interface LithicCard {
  token: string; last_four: string; pan?: string; cvv?: string; exp_month?: string; exp_year?: string;
  state: "OPEN" | "PAUSED" | "CLOSED" | "PENDING_FULFILLMENT" | "PENDING_ACTIVATION";
  type: string; spend_limit: number; spend_limit_duration: string;
}

export function createLithicSandbox(ctx: AdapterContext): IssuerAdapter {
  if (!ctx.apiKey) throw new Error("lithic-sandbox: missing API key (paygent secrets set lithic-sandbox.api_key)");
  const key = ctx.apiKey;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await ctx.http(`${BASE}${path}`, {
      method,
      headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      // Do not include the response body: some error bodies echo request fields.
      throw new Error(`lithic ${method} ${path.split("?")[0].replace(/[0-9a-f-]{36}/g, ":id")} failed: HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  return {
    manifest: lithicSandboxManifest,
    async createCard(req) {
      const exp = new Date(req.expiresAt);
      const card = await call<LithicCard>("POST", "/cards", {
        type: "SINGLE_USE",
        spend_limit: req.amountCents,
        spend_limit_duration: "TRANSACTION",
        memo: req.memo.slice(0, 60),
        state: "OPEN",
      });
      if (!card.pan || !card.cvv || !card.exp_month || !card.exp_year) {
        throw new Error("lithic: card response missing PAN fields");
      }
      ctx.log.info("card created", { providerCardId: card.token, last4: card.last_four });
      return {
        providerCardId: card.token,
        pan: card.pan, cvv: card.cvv, expMonth: card.exp_month, expYear: card.exp_year, last4: card.last_four,
        controls: {
          singleUse: card.type === "SINGLE_USE",
          capCents: card.spend_limit_duration === "TRANSACTION" || card.spend_limit_duration === "FOREVER" ? card.spend_limit : null,
          // Lithic card expiry is month-granular; Paygent enforces the short lifetime by freezing on expiry.
          expiresAt: exp.toISOString(),
        },
      };
    },
    async freezeCard(id) {
      await call("PATCH", `/cards/${encodeURIComponent(id)}`, { state: "PAUSED" });
    },
    async getCardStatus(id): Promise<CardStatus> {
      const card = await call<LithicCard>("GET", `/cards/${encodeURIComponent(id)}`);
      const tx = await call<{ data: { amount: number; status: string; merchant?: { descriptor?: string } }[] }>(
        "GET", `/transactions?card_token=${encodeURIComponent(id)}&page_size=20`);
      const state: CardStatus["state"] = card.state === "OPEN" ? "open" : card.state === "PAUSED" ? "frozen" : "closed";
      return {
        state: state === "closed" && tx.data.some((t) => t.status === "SETTLED") ? "used" : state,
        transactions: tx.data.map((t) => ({
          amountCents: Math.abs(t.amount),
          merchantDescriptor: t.merchant?.descriptor ?? "",
          status: t.status === "SETTLED" ? "settled" : t.status === "DECLINED" ? "declined" : "pending",
        })),
      };
    },
    // No simulateCharge: Lithic's /simulate/authorize needs the PAN, and adapters don't retain PANs.
    // Use the Lithic sandbox dashboard to simulate a charge.
  };
}
