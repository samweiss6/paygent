// Minimal third-party issuer adapter. Plain JavaScript, no dependencies.
// A real adapter would call its provider's sandbox through ctx.http (host-allowlisted).
// See docs/adapter-authoring.md.

import manifest from "./paygent-adapter.json" with { type: "json" };

export default function create(ctx) {
  const cards = new Map();
  let n = 0;
  return {
    manifest,
    async createCard(req) {
      const id = `ex_${++n}`;
      // Test PAN (Luhn-valid, from the 4000 0000 test range). A real adapter returns the provider's values.
      const pan = "4000000000000002";
      cards.set(id, { state: "open", cap: req.amountCents });
      ctx.log.info("created card", { id });
      return {
        providerCardId: id, pan, cvv: "123", expMonth: "12", expYear: "2030", last4: pan.slice(-4),
        controls: { singleUse: true, capCents: req.amountCents, expiresAt: req.expiresAt },
      };
    },
    async freezeCard(id) { const c = cards.get(id); if (c) c.state = "frozen"; },
    async getCardStatus(id) {
      const c = cards.get(id);
      if (!c) throw new Error("unknown card");
      return { state: c.state, transactions: [] };
    },
  };
}
