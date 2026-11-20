// Paygent owner dashboard. Plain ES module, no dependencies.
// All server data, especially agent-supplied text, is rendered with textContent, never as HTML.

const TOKEN_KEY = "paygent.token";
const REFRESH_MS = 5000;

// ---------- token ----------
(function captureToken() {
  const m = location.hash.match(/token=([A-Za-z0-9_-]+)/);
  if (m) {
    try { sessionStorage.setItem(TOKEN_KEY, m[1]); } catch { window.__paygentToken = m[1]; }
    history.replaceState(null, "", location.pathname);
  }
})();
const token = () => { try { return sessionStorage.getItem(TOKEN_KEY) ?? window.__paygentToken; } catch { return window.__paygentToken; } };

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "X-Paygent-Token": token() ?? "", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

// ---------- tiny DOM helper ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
function lockIcon() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "icon"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of [["rect", { x: "4", y: "11", width: "16", height: "10", rx: "2" }], ["path", { d: "M8 11V7a4 4 0 0 1 8 0v4" }]]) {
    const el = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); svg.append(el);
  }
  return svg;
}
/** Signature: a merchant a card is (or will be) locked to. */
const lockedMerchant = (domain, locked = true, align = false) => h("span", { class: "merchant", title: locked ? `Card works only at ${domain}` : null },
  locked ? lockIcon() : align ? h("span", { class: "icon-space", "aria-hidden": "true" }) : null, h("span", { text: domain }));
const money = (usd) => `$${Number(usd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cents = (c) => money(c / 100);
const when = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

const STATUS_LABEL = {
  pending_approval: "Needs approval", approved: "Approved", funding: "Funding", issued: "Card ready",
  settled: "Paid", declined: "Declined", denied: "Denied", rejected: "Rejected", cancelled: "Cancelled",
  expired: "Expired", failed: "Failed",
};
const REASON_LABEL = {
  new_merchant: "New merchant", above_approval_threshold: "Over approval threshold", above_hardware_threshold: "Needs hardware wallet",
};
const DENY_LABEL = {
  frozen: "Paygent is frozen", merchant_denied: "Merchant on deny list", blocked_category: "Blocked category",
  merchant_not_allowed: "Merchant not on allow list", exceeds_per_transaction_limit: "Over per-payment limit",
  velocity_limit: "Too many payments this hour", exceeds_daily_limit: "Over daily limit", exceeds_monthly_limit: "Over monthly limit",
  exceeds_merchant_daily_limit: "Over per-merchant limit", insufficient_allowance: "On-chain allowance used up",
  insufficient_funds: "Wallet balance too low", revoked: "Spend permission revoked", hardware_signer_not_configured: "No hardware signer set up",
};
const FUNDING_LABEL = { fiat_direct: "Bank or debit card", fiat_onramp: "On-ramp to your wallet", crypto_wallet: "Your crypto wallet" };

// ---------- state ----------
let last = null;
let policyDirty = false;

function setState(state, text) { const c = $("state"); c.dataset.state = state; c.textContent = text; }

function toast(msg, isError = false) {
  const t = h("div", { class: `toast${isError ? " err" : ""}`, role: isError ? "alert" : "status", text: msg });
  $("toasts").append(t);
  setTimeout(() => t.remove(), isError ? 7000 : 4000);
}

// ---------- render ----------
function renderStats(d) {
  const lim = d.policy.limits;
  const rem = d.status.policy_remaining;
  const spend = (id, label, left, cap, note) => {
    const used = Math.max(0, cap - left);
    const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
    const fill = h("div", { class: "meter-fill" }); fill.style.width = `${pct}%`;
    $(id).replaceChildren(
      h("div", { class: "label", text: label }),
      h("div", { class: "figure", text: money(left) }),
      h("div", { class: "of", text: `left of ${money(cap)} · ${note}` }),
      h("div", { class: "meter", dataset: { level: pct >= 85 ? "high" : "normal" } },
        h("div", { class: "meter-track", role: "meter", "aria-label": `${label}: ${money(used)} used`, "aria-valuemin": "0", "aria-valuemax": String(cap), "aria-valuenow": String(used) }, fill),
        h("div", { class: "meter-scale" }, h("span", { text: `${money(used)} used` }), h("span", { text: money(cap) }))),
    );
  };
  spend("stat-today", "Left today", rem ? Number(rem.today_usd) : 0, Number(lim.daily_usd), `up to ${money(lim.per_transaction_usd)} each`);
  spend("stat-month", "Left this month", rem ? Number(rem.this_month_usd) : 0, Number(lim.monthly_usd), "resets on the 1st");
  renderCard(d);

  const frozen = !!d.status.frozen;
  setState(frozen ? "frozen" : "active", frozen ? "Frozen" : "Active");
  $("frozen-banner").hidden = !frozen;
  if (frozen && d.status.frozen_at) $("frozen-detail").textContent = `Since ${when(d.status.frozen_at)}. No new payments, and every open card is frozen.`;
  $("kill").disabled = frozen;
}

/** The moment: the most recent single-use card, drawn as a card. Last 4 only, never the number. */
function renderCard(d) {
  const f = d.status.funding;
  const withCard = d.payments.filter((p) => p.card);
  const p = withCard.find((x) => x.status === "issued") ?? withCard[0];
  const funding = h("div", { class: "row" }, "Paid from ", h("b", { text: FUNDING_LABEL[f.path] ?? f.path }));
  const ext = f.externalLimit
    ? h("div", { class: "row", text: `On-chain allowance ${cents(f.externalLimit.remainingCents)} left today${f.externalLimit.revoked ? ", revoked" : ""}` })
    : h("div", { class: "row", text: `Cards from ${d.status.issuer}` });
  if (!p) {
    $("stat-card").replaceChildren(
      h("div", { class: "pcard-empty", text: "Cards appear here once you approve a payment" }),
      h("div", { class: "card-meta" }, h("div", { class: "label", text: "Latest card" }), funding, ext));
    return;
  }
  const live = p.status === "issued";
  const exp = p.card.expires_at ? new Date(p.card.expires_at) : null;
  const face = h("div", { class: "pcard", dataset: { state: live ? "live" : "spent" }, role: "img",
    "aria-label": `Single-use card ending ${p.card.last4}, locked to ${p.merchant}, limit ${money(p.card_cap_usd)}` },
    h("div", { class: "pcard-top" }, h("span", { class: "issuer", text: "Paygent" }), h("span", { class: "use", text: live ? "Single use" : (STATUS_LABEL[p.status] ?? p.status) })),
    h("div", {}, h("div", { class: "chip" })),
    h("div", { class: "pcard-number", text: `•••• •••• •••• ${p.card.last4}` }),
    h("div", { class: "pcard-foot" },
      h("span", { class: "lock" }, lockIcon(), h("span", { text: p.merchant })),
      h("span", { class: "cap" }, h("small", { text: "Limit" }), money(p.card_cap_usd))),
  );
  $("stat-card").replaceChildren(face, h("div", { class: "card-meta" },
    h("span", { class: `status s-${p.status}`, text: live ? `Ready at ${p.merchant}` : `${STATUS_LABEL[p.status] ?? p.status} · ${p.merchant}` }),
    live && exp ? h("div", { class: "row", text: `Expires ${when(exp.toISOString())}` }) : null,
    funding, ext));
}

function renderPending(d) {
  const list = d.pending;
  $("pending-count").textContent = list.length ? String(list.length) : "";
  const box = $("pending"); box.replaceChildren();
  if (!list.length) { box.append(h("p", { class: "empty", text: "Nothing waiting. First-time merchants and payments over your approval amount show up here." })); return; }
  for (const p of list) {
    const hw = p.approval.level === "hardware";
    box.append(h("article", { class: "request", "aria-label": `${p.merchant}, ${money(p.amount_usd)}` },
      h("div", {},
        h("div", { class: "who" }, lockedMerchant(p.merchant)),
        h("div", { class: "sub" },
          p.approval.reasons.map((r, i) => [i ? " · " : "", h("span", { class: r === "above_hardware_threshold" ? "tag-caution" : "", text: REASON_LABEL[r] ?? r })]),
          ` · card limit ${money(p.card_cap_usd)}`,
          p.approval.expires_at ? ` · decide by ${when(p.approval.expires_at)}` : ""),
      ),
      h("div", { class: "amount", text: money(p.amount_usd) }),
      p.description ? h("div", { class: "note" }, h("span", { class: "note-label", text: "Your agent's note, not verified" }), p.description) : null,
      h("div", { class: "actions" },
        h("button", { class: "btn btn-secondary", type: "button", onclick: () => openDecision(p, "reject"), text: "Reject" }),
        hw
          ? h("button", { class: "btn btn-primary", type: "button", disabled: true, title: "Approve with your hardware wallet: paygent approve " + p.payment_id, text: "Needs hardware wallet" })
          : h("button", { class: "btn btn-primary", type: "button", onclick: () => openDecision(p, "approve"), text: `Approve ${money(p.amount_usd)}` }),
      ),
    ));
  }
}

function renderPayments(d) {
  const t = $("payments"); t.replaceChildren();
  if (!d.payments.length) { t.append(h("tbody", {}, h("tr", {}, h("td", { class: "empty", text: "No payments yet" })))); return; }
  t.append(h("thead", {}, h("tr", {},
    h("th", { text: "Merchant" }), h("th", { class: "num", text: "Amount" }), h("th", { text: "Status" }),
    h("th", { text: "Card" }), h("th", { text: "Agent's note" }), h("th", { class: "num", text: "Time" }))));
  t.append(h("tbody", {}, d.payments.map((p) => h("tr", {},
    h("td", { class: "m" }, lockedMerchant(p.merchant, !!p.card, true)),
    h("td", { class: "num", text: money(p.settled_usd ?? p.amount_usd) }),
    h("td", { class: "status-cell" }, h("span", { class: `status s-${p.status}`, text: STATUS_LABEL[p.status] ?? p.status }),
      p.deny_reason ? h("span", { class: "why", text: DENY_LABEL[p.deny_reason] ?? p.deny_reason }) : null),
    h("td", { class: "card", text: p.card ? `•••• ${p.card.last4}` : "" }),
    h("td", { class: "desc", title: p.description, text: p.description }),
    h("td", { class: "when num", text: when(p.created_at) }),
  ))));
}

function renderPolicy(d) {
  if (policyDirty) return;
  const p = d.policy;
  const f = $("policy"); f.replaceChildren();
  const usd = (name, label, value) => h("label", { class: "field" }, h("span", { text: label }),
    h("div", { class: "prefix" }, h("span", { text: "$" }), h("input", { name, inputmode: "decimal", value, autocomplete: "off", pattern: "\\d+(\\.\\d{1,2})?", required: true })));
  const num = (name, label, value, min, max) => h("label", { class: "field" }, h("span", { text: label }),
    h("input", { name, type: "number", inputmode: "numeric", min, max, step: "1", value, required: true }));
  const list = (name, label, values, placeholder) => h("label", { class: "field wide" }, h("span", { text: label }),
    h("textarea", { name, spellcheck: "false", placeholder, rows: Math.max(2, Math.min(6, values.length)) }, values.join("\n")));
  f.append(
    h("div", { class: "form-grid" },
      h("div", { class: "group", text: "Spending limits" }),
      usd("limits.per_transaction_usd", "Per payment", p.limits.per_transaction_usd),
      usd("limits.per_merchant_daily_usd", "Per merchant, daily", p.limits.per_merchant_daily_usd),
      usd("limits.daily_usd", "Per day", p.limits.daily_usd),
      usd("limits.monthly_usd", "Per month", p.limits.monthly_usd),
      num("limits.max_payments_per_hour", "Payments per hour", p.limits.max_payments_per_hour, 1, 1000),
      h("div", { class: "group", text: "When to ask you" }),
      usd("approval.require_above_usd", "Ask above", p.approval.require_above_usd),
      h("label", { class: "field check" }, h("input", { type: "checkbox", name: "approval.require_for_new_merchant", checked: p.approval.require_for_new_merchant }),
        h("span", { text: "Ask before paying a merchant for the first time" })),
      h("div", { class: "group", text: "Merchants" }),
      list("merchants.allow", "Trusted (no first-time check)", p.merchants.allow, "example.com"),
      list("merchants.deny", "Never pay", p.merchants.deny, "example.com"),
    ),
    h("div", { class: "form-actions", dataset: { dirty: "false" } },
      h("button", { class: "btn btn-secondary", type: "button", onclick: () => { policyDirty = false; renderPolicy(last); }, text: "Discard" }),
      h("button", { class: "btn btn-primary", type: "submit", text: "Review and sign" })),
  );
}

function readPolicyForm() {
  const f = $("policy"); const out = {};
  const p = last.policy;
  const get = (path) => path.split(".").reduce((o, k) => o[k], p);
  for (const el of f.elements) {
    if (!el.name) continue;
    let v;
    if (el.type === "checkbox") v = el.checked;
    else if (el.type === "number") v = Number(el.value);
    else if (el.tagName === "TEXTAREA") v = el.value.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    else v = normalizeUsd(el.value);
    if (JSON.stringify(v) !== JSON.stringify(get(el.name))) out[el.name] = v;
  }
  return out;
}
const normalizeUsd = (s) => { const n = String(s).replace(/[$,\s]/g, ""); return /^\d+(\.\d{1,2})?$/.test(n) ? Number(n).toFixed(2) : n; };

function renderAudit(d) {
  const v = d.audit.verify;
  const ver = $("audit-verify"); ver.replaceChildren();
  ver.append(v.ok ? h("span", { class: "verify-ok", text: `Chain intact · ${v.count} entries` }) : h("span", { class: "verify-bad", text: `Tampering detected at line ${v.badLine}` }));
  const ol = $("audit"); ol.replaceChildren();
  for (const e of d.audit.entries) {
    const short = (v) => String(v).replace(/\b(pay|mock|card)_([0-9a-f]{8})[0-9a-f-]{20,}/gi, "$1_$2…");
    const summary = Object.entries(e.data ?? {}).filter(([, val]) => val !== null && val !== undefined)
      .map(([k, val]) => `${k.replace(/_id$/, "")} ${short(typeof val === "object" ? JSON.stringify(val) : val)}`).join(" · ");
    ol.append(h("li", {}, h("span", { class: "seq", text: `#${e.seq}` }), h("span", { class: "type", title: when(e.ts), text: e.type }), h("span", { class: "data", text: summary.slice(0, 400) })));
  }
}

function render(d) {
  last = d;
  renderStats(d); renderPending(d); renderPayments(d); renderPolicy(d); renderAudit(d);
  $("app").setAttribute("aria-busy", "false");
}

async function refresh() {
  if (!token()) { setState("down", "No dashboard token"); showNoToken(); return; }
  try {
    render(await api("GET", "/api/overview"));
  } catch (e) {
    setState("down", e.status === 401 ? "Link expired" : e.message.includes("daemon not running") ? "Daemon not running" : "Disconnected");
    if (e.status === 401) showNoToken();
  }
}

function showNoToken() {
  const box = $("pending"); box.replaceChildren(h("p", { class: "empty", text: "Open the link that `paygent ui` printed in your terminal. It includes a one-time token for this dashboard." }));
}

// ---------- sheet (dialog) ----------
let sheetAction = null;
function openSheet({ title, body, okText, okClass = "btn-primary", needsPass = true, action }) {
  $("sheet-title").textContent = title;
  $("sheet-body").replaceChildren(...[body].flat().filter(Boolean));
  $("pass-field").hidden = !needsPass;
  $("pass").required = needsPass;
  $("sheet-error").textContent = "";
  const ok = $("sheet-ok"); ok.textContent = okText; ok.className = `btn ${okClass}`; ok.disabled = false;
  sheetAction = action;
  $("sheet").showModal();
  (needsPass ? $("pass") : ok).focus();
}
function closeSheet() { $("pass").value = ""; $("sheet").close(); sheetAction = null; }

$("sheet-cancel").addEventListener("click", closeSheet);
$("sheet").addEventListener("close", () => { $("pass").value = ""; });
$("sheet-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!sheetAction) return;
  const ok = $("sheet-ok"); ok.disabled = true; $("sheet-error").textContent = "";
  try {
    const done = await sheetAction($("pass").value);
    if (done !== false) { closeSheet(); await refresh(); }
  } catch (e) {
    $("sheet-error").textContent = e.message;
  } finally { ok.disabled = false; }
});

function openDecision(p, decision) {
  const approve = decision === "approve";
  openSheet({
    title: approve ? `Approve ${money(p.amount_usd)} at ${p.merchant}?` : `Reject the payment to ${p.merchant}?`,
    body: h("p", { class: "summary" }, approve
      ? ["Paygent will issue a single-use card capped at ", h("strong", { text: money(p.card_cap_usd) }), " that works for one charge and expires within the hour."]
      : ["The agent will be told you rejected it. Nothing is charged."]),
    okText: approve ? "Approve" : "Reject",
    okClass: approve ? "btn-primary" : "btn-destructive",
    action: async (passphrase) => {
      const r = await api("POST", "/api/decision", { payment_id: p.payment_id, decision, passphrase });
      toast(approve ? (r.status === "issued" ? `Card ready for ${p.merchant} (•••• ${r.card?.last4 ?? ""})` : `Approved; status: ${STATUS_LABEL[r.status] ?? r.status}`) : "Rejected");
    },
  });
}

function openUnfreeze() {
  openSheet({
    title: "Unfreeze Paygent?",
    body: h("p", { class: "summary", text: "Payments can be requested again. If you use a wallet, the on-chain permission stays revoked until you approve a new one in your wallet." }),
    okText: "Unfreeze",
    action: async (passphrase) => { await api("POST", "/api/unfreeze", { passphrase }); toast("Unfrozen"); },
  });
}

$("kill").addEventListener("click", () => openSheet({
  title: "Freeze everything now?",
  body: h("p", { class: "summary", text: "Stops all new payments, freezes every open card, cancels pending requests, and revokes the on-chain spend permission if you use a wallet. You'll need your owner passphrase to unfreeze." }),
  okText: "Freeze everything",
  okClass: "btn-destructive",
  needsPass: false,
  action: async () => {
    const r = await api("POST", "/api/kill", { confirm: "kill" });
    toast(r.owner_action ?? "Frozen. All open cards are frozen.");
  },
}));

const markDirty = (e) => { if (!e.target.closest("#policy")) return; policyDirty = true; const a = $("policy").querySelector(".form-actions"); if (a) a.dataset.dirty = "true"; };
$("app").addEventListener("input", markDirty);
$("app").addEventListener("change", markDirty);
$("unfreeze").addEventListener("click", openUnfreeze);
$("policy").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const changes = readPolicyForm();
  if (!Object.keys(changes).length) { toast("No changes to save"); policyDirty = false; return; }
  const diffList = (diff) => h("div", { class: "diff" }, diff.map((d) => h("div", {},
    h("code", { text: d.path }), `: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)} `, d.loosens ? h("span", { class: "loosen", text: "loosens" }) : "")));
  let confirmLoosen = false;
  openSheet({
    title: "Save policy changes?",
    body: h("p", { class: "summary", text: `${Object.keys(changes).length} change${Object.keys(changes).length > 1 ? "s" : ""}. Paygent signs the new policy with your owner key.` }),
    okText: "Sign and save",
    action: async (passphrase) => {
      const r = await api("POST", "/api/policy", { changes, passphrase, confirm_loosen: confirmLoosen });
      if (r.needs_confirmation) {
        confirmLoosen = true;
        $("sheet-title").textContent = "These changes give your agent more room";
        $("sheet-body").replaceChildren(h("p", { class: "summary", text: "Check them before you sign:" }), diffList(r.diff));
        $("sheet-ok").textContent = "Loosen and save";
        return false; // keep the sheet open
      }
      policyDirty = false;
      toast(r.note ?? "Policy saved and signed");
    },
  });
});

refresh();
setInterval(() => { if (!$("sheet").open) refresh(); }, REFRESH_MS);
