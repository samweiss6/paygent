// Mock on-ramp for dry runs and tests. Pretends the owner completed KYC and paid by ACH; on
// completion it credits the mock authority's owner balance (the same thing a real on-ramp does
// by sending USDC to the owner's wallet).

import { randomUUID } from "node:crypto";
import type { AdapterContext, OnrampAdapter, OnrampManifest, TopUpState } from "../types.ts";

export const mockOnrampManifest: OnrampManifest = {
  id: "mock-onramp",
  kind: "onramp",
  displayName: "Mock on-ramp (no real money)",
  version: "0.1.0",
  allowedHosts: [],
  delivers: ["USDC:mock", "USDC:base-sepolia"],
  testModeOnly: true,
};

export function createMockOnramp(_ctx: AdapterContext, onDeliver: (address: string, units: bigint) => void): OnrampAdapter {
  const sessions = new Map<string, { state: TopUpState; units: bigint; to: string; key: string }>();
  return {
    manifest: mockOnrampManifest,
    async createTopUp(req) {
      for (const [id, s] of sessions) if (s.key === req.idempotencyKey) return { providerSessionId: id, hostedUrl: `https://onramp.mock.invalid/session/${id}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
      const id = `mockramp_${randomUUID()}`;
      sessions.set(id, { state: "created", units: BigInt(req.amountCents) * 10_000n, to: req.destinationAddress, key: req.idempotencyKey });
      return { providerSessionId: id, hostedUrl: `https://onramp.mock.invalid/session/${id}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    },
    async getTopUpStatus(id) {
      const s = sessions.get(id);
      if (!s) throw new Error("unknown session");
      return { state: s.state, deliveredUnits: s.state === "completed" ? s.units.toString() : null, txHash: s.state === "completed" ? `mock-tx-${id}` : null };
    },
    async simulateComplete(id) {
      const s = sessions.get(id);
      if (!s || s.state === "completed") return;
      s.state = "completed";
      onDeliver(s.to, s.units);
    },
  };
}
