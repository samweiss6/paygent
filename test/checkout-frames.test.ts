// checkout_fill into payment-processor iframes (e.g. Stripe Elements, one iframe per field).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fillCheckout } from "../src/checkout/cdp.ts";

const card = { pan: "4000001234567899", cvv: "123", expMonth: "07", expYear: "2028" };

interface FakeTarget { id: string; type: "page" | "iframe"; url: string; parentId?: string; fields: string[]; actualHost?: string }

function fakeBrowser(targets: FakeTarget[]) {
  const values: Record<string, Record<string, string>> = {};
  const fetchImpl = (async () => new Response(JSON.stringify(targets.map((t) => ({
    id: t.id, type: t.type, url: t.url, parentId: t.parentId, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/${t.type}/${t.id}`,
  }))))) as typeof fetch;
  class FakeWS {
    onopen?: () => void; onmessage?: (e: { data: string }) => void; onerror?: () => void;
    url: string;
    constructor(url: string) { this.url = url; setTimeout(() => this.onopen?.(), 0); }
    send(raw: string) {
      const msg = JSON.parse(raw);
      const t = targets.find((x) => this.url.endsWith("/" + x.id))!;
      const u = new URL(t.url);
      class HTMLInputElement { _v = ""; dispatchEvent() {} }
      Object.defineProperty(HTMLInputElement.prototype, "value", { set(v) { this._v = v; }, get() { return this._v; }, configurable: true });
      class HTMLSelectElement extends HTMLInputElement {}
      const els: Record<string, HTMLInputElement> = {};
      const ctx = {
        location: { hostname: t.actualHost ?? u.hostname, protocol: u.protocol },
        document: { querySelector: (s: string) => (t.fields.includes(s) ? (els[s] ??= new HTMLInputElement()) : null) },
        HTMLInputElement, HTMLSelectElement, Event: class { t: string; constructor(t: string) { this.t = t; } },
      };
      const value = vm.runInNewContext(msg.params.expression, ctx);
      values[t.id] = Object.fromEntries(Object.entries(els).map(([k, v]) => [k, (v as unknown as { _v: string })._v]));
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result: { result: { value } } }) }), 0);
    }
    close() {}
  }
  return { fetchImpl, WebSocketImpl: FakeWS as unknown as typeof WebSocket, values };
}

const sel = { number: "input[name=cardnumber]", cvv: "input[name=cvc]", exp: "input[name=exp-date]" };
const base = { cdpEndpoint: "http://127.0.0.1:9222", merchant: "bookshop.org", merchantRegistrable: "bookshop.org", selectors: sel, card, allowedFrameHosts: ["js.stripe.com"] };

test("fills one-field-per-iframe Stripe Elements under the merchant's page", async () => {
  const b = fakeBrowser([
    { id: "P1", type: "page", url: "https://bookshop.org/checkout", fields: [] },
    { id: "F1", type: "iframe", url: "https://js.stripe.com/v3/elements-inner-card.html", parentId: "P1", fields: [sel.number] },
    { id: "F2", type: "iframe", url: "https://js.stripe.com/v3/elements-inner-exp.html", parentId: "P1", fields: [sel.exp] },
    { id: "F3", type: "iframe", url: "https://js.stripe.com/v3/elements-inner-cvc.html", parentId: "P1", fields: [sel.cvv] },
  ]);
  const r = await fillCheckout({ ...base, frameHost: "js.stripe.com", ...b });
  assert.deepEqual(r.filled.sort(), ["cvv", "exp", "number"]);
  assert.deepEqual(r.missing, []);
  assert.equal(b.values.F1[sel.number], card.pan);
  assert.ok(!JSON.stringify(r).includes(card.pan));
});

test("refuses frames whose parent is not the merchant (attacker page embedding Stripe)", async () => {
  const b = fakeBrowser([
    { id: "P1", type: "page", url: "https://bookshop.org/checkout", fields: [] },
    { id: "P2", type: "page", url: "https://evil.com/fake-checkout", fields: [] },
    { id: "F1", type: "iframe", url: "https://js.stripe.com/v3/elements-inner-card.html", parentId: "P2", fields: [sel.number, sel.cvv, sel.exp] },
  ]);
  await assert.rejects(fillCheckout({ ...base, frameHost: "js.stripe.com", ...b }), /no js\.stripe\.com payment frame/);
  assert.equal(Object.keys(b.values).length, 0);
});

test("refuses frame hosts not on the policy list, and frames that navigated elsewhere", async () => {
  const b = fakeBrowser([
    { id: "P1", type: "page", url: "https://bookshop.org/checkout", fields: [] },
    { id: "F1", type: "iframe", url: "https://evil-pay.com/card", parentId: "P1", fields: [sel.number] },
    { id: "F2", type: "iframe", url: "https://js.stripe.com/v3/x.html", parentId: "P1", fields: [sel.number], actualHost: "evil.com" },
  ]);
  await assert.rejects(fillCheckout({ ...base, frameHost: "evil-pay.com", ...b }), /not in the policy's payment_frame_hosts/);
  await assert.rejects(fillCheckout({ ...base, frameHost: "js.stripe.com", ...b }), /refused to fill/);
  assert.equal(Object.values(b.values).filter((v) => Object.keys(v).length).length, 0);
});
