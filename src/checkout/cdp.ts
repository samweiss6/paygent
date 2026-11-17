// Checkout injector over the Chrome DevTools Protocol. Paygent connects to the agent's browser,
// confirms the top-level page belongs to the card's merchant, and types the card fields itself.
// Card values travel only between this process and the local browser; the MCP response lists
// which fields were filled, never their values.
//
// Payment-processor iframes (e.g. Stripe Elements) are supported when the caller names the frame
// host, the host is on the policy's payment_frame_hosts list, and the frame's parent target is
// the merchant's page. Each matching frame is filled with whatever selectors it contains.
//
// Limitation (documented in the threat model): after filling, values sit in the DOM of the page
// or frame, where a browser-driving agent with same-origin access could read them.

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

interface Target { id?: string; type: string; url: string; parentId?: string; webSocketDebuggerUrl?: string }

/** The function evaluated in the page. It re-checks the hostname in the page itself. */
function pageFill(expectHost: string, allowSubdomains: boolean, sel: FillSelectors, card: CardSecret) {
  const host = location.hostname.toLowerCase();
  if (location.protocol !== "https:" || !(host === expectHost || (allowSubdomains && host.endsWith("." + expectHost)))) {
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

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

function hostOf(url: string): { host: string; https: boolean } | null {
  try { const u = new URL(url); return { host: u.hostname.toLowerCase(), https: u.protocol === "https:" }; } catch { return null; }
}

async function evaluateIn(target: Target, expression: string, WS: typeof WebSocket, timeoutMs: number) {
  const ws = new URL(target.webSocketDebuggerUrl!);
  if (!LOOPBACK.includes(ws.hostname)) throw new CheckoutError("CDP websocket must be on loopback");
  return new Promise<{ error?: string; host: string; filled?: string[]; missing?: string[] }>((resolve, reject) => {
    const sock = new WS(ws.toString());
    const timer = setTimeout(() => { try { sock.close(); } catch {} reject(new CheckoutError("CDP timeout")); }, timeoutMs);
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
}

export async function fillCheckout(args: {
  cdpEndpoint: string; merchant: string; merchantRegistrable: string; selectors: FillSelectors; card: CardSecret;
  frameHost?: string; allowedFrameHosts?: string[];
  fetchImpl?: typeof fetch; WebSocketImpl?: typeof WebSocket; timeoutMs?: number;
}): Promise<FillResult> {
  const base = validateCdpEndpoint(args.cdpEndpoint);
  validateSelectors(args.selectors);
  const frameHost = args.frameHost?.toLowerCase();
  if (frameHost !== undefined && !(args.allowedFrameHosts ?? []).includes(frameHost)) {
    throw new CheckoutError(`frame host ${frameHost} is not in the policy's payment_frame_hosts`);
  }
  const f = args.fetchImpl ?? fetch;
  const res = await f(new URL("/json/list", base).toString(), { redirect: "error" });
  if (!res.ok) throw new CheckoutError(`CDP endpoint returned HTTP ${res.status}`);
  const targets = (await res.json()) as Target[];
  const isMerchantPage = (t: Target) => {
    if (t.type !== "page") return false;
    const h = hostOf(t.url);
    return !!h && h.https && sameMerchant(h.host, args.merchant);
  };
  const WS = args.WebSocketImpl ?? WebSocket;
  const timeout = args.timeoutMs ?? 10_000;

  if (frameHost === undefined) {
    const page = targets.find((t) => isMerchantPage(t) && t.webSocketDebuggerUrl);
    if (!page) throw new CheckoutError(`no open https page for ${args.merchantRegistrable} in that browser`);
    const expression = `(${pageFill.toString()})(${JSON.stringify(args.merchantRegistrable)}, true, ${JSON.stringify(args.selectors)}, ${JSON.stringify(args.card)})`;
    const r = await evaluateIn(page, expression, WS, timeout);
    if (r.error === "origin_mismatch") throw new CheckoutError(`page host ${r.host} does not belong to ${args.merchantRegistrable}; refused to fill`);
    return { filled: r.filled ?? [], missing: r.missing ?? [], page_host: r.host };
  }

  // Payment iframes: only frames on the named processor host whose parent is the merchant's page.
  const merchantPageIds = new Set(targets.filter(isMerchantPage).map((t) => t.id).filter(Boolean));
  if (merchantPageIds.size === 0) throw new CheckoutError(`no open https page for ${args.merchantRegistrable} in that browser`);
  const frames = targets.filter((t) => {
    const h = hostOf(t.url);
    return t.type === "iframe" && t.webSocketDebuggerUrl && h?.https && h.host === frameHost && t.parentId && merchantPageIds.has(t.parentId);
  });
  if (frames.length === 0) throw new CheckoutError(`no ${frameHost} payment frame inside the ${args.merchantRegistrable} page`);
  const expression = `(${pageFill.toString()})(${JSON.stringify(frameHost)}, false, ${JSON.stringify(args.selectors)}, ${JSON.stringify(args.card)})`;
  const filled = new Set<string>();
  for (const fr of frames) {
    const r = await evaluateIn(fr, expression, WS, timeout);
    if (r.error === "origin_mismatch") throw new CheckoutError(`frame host ${r.host} is not ${frameHost}; refused to fill`);
    (r.filled ?? []).forEach((x) => filled.add(x));
  }
  const wanted = ["number", "cvv", ...(args.selectors.exp ? ["exp"] : []), ...(args.selectors.exp_month ? ["exp_month"] : []), ...(args.selectors.exp_year ? ["exp_year"] : [])];
  return { filled: [...filled], missing: wanted.filter((w) => !filled.has(w)), page_host: frameHost };
}
