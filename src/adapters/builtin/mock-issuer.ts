// Mock issuer for dry runs and tests. Issues Luhn-valid numbers in the 4000 0000 test range that
// no real network will authorize. Enforces single use, cap, expiry, and freeze like a real issuer.

import { randomInt, randomUUID } from "node:crypto";
import type { AdapterContext, CardStatus, CreateCardRequest, IssuedCard, IssuerAdapter, IssuerManifest } from "../types.ts";

export const mockIssuerManifest: IssuerManifest = {
  id: "mock",
  kind: "issuer",
  fundingModels: ["usdc_deposit", "fiat_linked"],
  displayName: "Mock issuer (no real cards)",
  version: "0.1.0",
  allowedHosts: [],
  capabilities: { singleUse: true, merchantLock: "first_use", perCardCap: true, expiry: true, freeze: true },
  testModeOnly: true,
};

function luhnComplete(prefix: string): string {
  let sum = 0;
  for (let i = 0; i < prefix.length; i++) {
    let n = Number(prefix[prefix.length - 1 - i]);
    if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return prefix + String((10 - (sum % 10)) % 10);
}

interface MockCard { req: CreateCardRequest; card: IssuedCard; state: CardStatus["state"]; tx: CardStatus["transactions"]; merchant: string | null }

export function createMockIssuer(_ctx: AdapterContext, opts: { misbehave?: "ignore_cap" | "multi_use"; now?: () => number } = {}): IssuerAdapter {
  const now = opts.now ?? Date.now;
  const cards = new Map<string, MockCard>();
  return {
    manifest: mockIssuerManifest,
    async createCard(req) {
      const pan = luhnComplete("400000" + String(randomInt(0, 1e9)).padStart(9, "0"));
      const exp = new Date(req.expiresAt);
      const card: IssuedCard = {
        providerCardId: `mock_${randomUUID()}`,
        pan, cvv: String(randomInt(100, 1000)),
        expMonth: String(exp.getUTCMonth() + 1).padStart(2, "0"), expYear: String(exp.getUTCFullYear() + 2),
        last4: pan.slice(-4),
        controls: {
          singleUse: opts.misbehave !== "multi_use",
          capCents: opts.misbehave === "ignore_cap" ? null : req.amountCents,
          expiresAt: req.expiresAt,
        },
      };
      cards.set(card.providerCardId, { req, card, state: "open", tx: [], merchant: null });
      return card;
    },
    async freezeCard(id) {
      const c = cards.get(id);
      if (c && c.state === "open") c.state = "frozen";
    },
    async getCardStatus(id) {
      const c = cards.get(id);
      if (!c) throw new Error("unknown card");
      if (c.state === "open" && now() > Date.parse(c.req.expiresAt)) c.state = "closed";
      return { state: c.state, transactions: [...c.tx] };
    },
    async simulateCharge(id, amountCents, descriptor) {
      const c = cards.get(id);
      if (!c) throw new Error("unknown card");
      const ok = c.state === "open" && amountCents <= (c.card.controls.capCents ?? Infinity) &&
        now() <= Date.parse(c.req.expiresAt) && (c.merchant === null || c.merchant === descriptor);
      c.tx.push({ amountCents, merchantDescriptor: descriptor, status: ok ? "settled" : "declined" });
      if (ok) { c.merchant = descriptor; if (c.card.controls.singleUse) c.state = "used"; }
    },
  };
}
