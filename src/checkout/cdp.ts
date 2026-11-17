// Checkout injector over the Chrome DevTools Protocol. Paygent connects to the agent's browser,
// confirms the top-level page belongs to the card's merchant, and types the card fields itself.
// Card values travel only between this process and the local browser; the MCP response lists
// which fields were filled, never their values.
//
// Limitations (documented in the threat model): fields inside cross-origin iframes (e.g. hosted
// payment fields) are not filled in v0.1; after filling, the values sit in the page DOM where a
// browser-driving agent could read them.

import { sameMerchant } from "../merchant.ts";
import type { CardSecret } from "../vault.ts";

export interface FillSelectors {
  number: string;
  cvv: string;
  exp?: string;        // combined "MM/YY" field
  exp_month?: string;
  exp_year?: string;
}

export interface FillResult { filled: string[]; missing: string[]; page_host: string }

export class CheckoutError extends Error {}

const SELECTOR_RE = /^[A-Za-z0-9_\-#.\[\]="':\s>*~+()^$|,]{1,200}$/;

export function validateCdpEndpoint(endpoint: string): URL {
  let u: URL;
  try { u = new URL(endpoint); } catch { throw new CheckoutError("cdp_endpoint must be a URL like http://127.0.0.1:9222"); }
  if (u.protocol !== "http:") throw new CheckoutError("cdp_endpoint must use http on loopback");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new CheckoutError("cdp_endpoint must be on loopback");
  if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "")) throw new CheckoutError("cdp_endpoint must be a bare origin");
  return u;
}

export function validateSelectors(s: FillSelectors) {
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) continue;
    if (typeof v !== "string" || !SELECTOR_RE.test(v)) throw new CheckoutError(`selector ${k} has unsupported characters`);
  }
  if (!s.exp && !(s.exp_month && s.exp_year)) throw new CheckoutError("provide exp, or exp_month and exp_year");
}

interface Target { type: string; url: string; webSocketDebuggerUrl?: string }

/** The function evaluated in the page. It re-checks the hostname in the page itself. */
function pageFill(merchantRegistrable: string, sel: FillSelectors, card: CardSecret) {
  const host = location.hostname.toLowerCase();
  if (location.protocol !== "https:" || !(host === merchantRegistrable || host.endsWith("." + merchantRegistrable))) {
    return { error: "origin_mismatch", host };
  }
  const filled: string[] = [], missing: string[] = [];
  const set = (name: string, selector: string | undefined, value: string) => {
    if (!selector) return;
    const el = document.querySelector(selector) as any;
    if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) { missing.push(name); return; }
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    filled.push(name);
  };
  set("number", sel.number, card.pan);
  set("cvv", sel.cvv, card.cvv);
  set("exp", sel.exp, `${card.expMonth}/${card.expYear.slice(-2)}`);
  set("exp_month", sel.exp_month, card.expMonth);
  set("exp_year", sel.exp_year, card.expYear);
  return { filled, missing, host };
}

declare const location: { hostname: string; protocol: string };
declare const document: { querySelector(s: string): unknown };
declare const HTMLInputElement: any;
declare const HTMLSelectElement: any;

export async function fillCheckout(args: {
  cdpEndpoint: string; merchant: string; merchantRegistrable: string; selectors: FillSelectors; card: CardSecret;
  fetchImpl?: typeof fetch; WebSocketImpl?: typeof WebSocket; timeoutMs?: number;
}): Promise<FillResult> {
  const base = validateCdpEndpoint(args.cdpEndpoint);
  validateSelectors(args.selectors);
  const f = args.fetchImpl ?? fetch;
  const res = await f(new URL("/json/list", base).toString(), { redirect: "error" });
  if (!res.ok) throw new CheckoutError(`CDP endpoint returned HTTP ${res.status}`);
  const targets = (await res.json()) as Target[];
  const page = targets.find((t) => {
    if (t.type !== "page" || !t.webSocketDebuggerUrl) return false;
    try { const u = new URL(t.url); return u.protocol === "https:" && sameMerchant(u.hostname, args.merchant); } catch { return false; }
  });
  if (!page) throw new CheckoutError(`no open https page for ${args.merchantRegistrable} in that browser`);
  const ws = new URL(page.webSocketDebuggerUrl!);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(ws.hostname)) throw new CheckoutError("CDP websocket must be on loopback");

  const expression = `(${pageFill.toString()})(${JSON.stringify(args.merchantRegistrable)}, ${JSON.stringify(args.selectors)}, ${JSON.stringify(args.card)})`;
  const WS = args.WebSocketImpl ?? WebSocket;
  const result = await new Promise<{ error?: string; host: string; filled?: string[]; missing?: string[] }>((resolve, reject) => {
    const sock = new WS(ws.toString());
    const timer = setTimeout(() => { try { sock.close(); } catch {} reject(new CheckoutError("CDP timeout")); }, args.timeoutMs ?? 10_000);
    sock.onopen = () => sock.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: false, silent: true } }));
    sock.onerror = () => { clearTimeout(timer); reject(new CheckoutError("CDP connection failed")); };
    sock.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      sock.close();
      if (msg.error || msg.result?.exceptionDetails) return reject(new CheckoutError("page script failed"));
      resolve(msg.result.result.value);
    };
  });
  if (result.error === "origin_mismatch") throw new CheckoutError(`page host ${result.host} does not belong to ${args.merchantRegistrable}; refused to fill`);
  return { filled: result.filled ?? [], missing: result.missing ?? [], page_host: result.host };
}
