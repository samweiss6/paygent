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

function setConn(state, text) { const c = $("conn"); c.dataset.state = state; c.textContent = text; }

function toast(msg, isError = false) {
  const t = h("div", { class: `toast glass${isError ? " err" : ""}`, role: isError ? "alert" : "status", text: msg });
  $("toasts").append(t);
  setTimeout(() => t.remove(), isError ? 7000 : 4000);
}

// ---------- render ----------
function renderStats(d) {
  const lim = d.policy.limits;
  const rem = d.status.policy_remaining;
  const stat = (id, label, value, sub, opts = {}) => {
    const el = $(id); el.replaceChildren(); el.removeAttribute("data-tone");
    if (opts.tone) el.dataset.tone = opts.tone;
    el.append(h("div", { class: "label", text: label }), value, opts.meter ?? "", h("div", { class: "sub" }, sub));
  };
  const meter = (used, total) => {
    const pct = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
    const bar = h("span"); bar.style.width = `${pct}%`;
    return h("div", { class: "meter", role: "meter", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(used) }, bar);
  };
  const dayCap = Number(lim.daily_usd), dayLeft = rem ? Number(rem.today_usd) : 0;
  const monCap = Number(lim.monthly_usd), monLeft = rem ? Number(rem.this_month_usd) : 0;
  stat("stat-today", "Left today", h("div", { class: "value" }, money(dayLeft), " ", h("small", { text: `of ${money(dayCap)}` })),
    `Up to ${money(lim.per_transaction_usd)} per payment`, { meter: meter(dayCap - dayLeft, dayCap) });
  stat("stat-month", "Left this month", h("div", { class: "value" }, money(monLeft), " ", h("small", { text: `of ${money(monCap)}` })),
    `Resets on the 1st (UTC)`, { meter: meter(monCap - monLeft, monCap) });

  const f = d.status.funding;
  const ext = f.externalLimit;
  stat("stat-funding", "Funding", h("div", { class: "value", style: "font-size:20px" }, FUNDING_LABEL[f.path] ?? f.path),
    ext ? `On-chain allowance: ${cents(ext.remainingCents)} left today${ext.revoked ? " (revoked)" : ""}` : "Limits: your policy and the issuer's card controls");

  const frozen = d.status.frozen;
  const stateVal = h("div", { class: "value" }, frozen ? "Frozen" : "Active");
  const sub = frozen
    ? h("span", {}, d.status.frozen_at ? `Since ${when(d.status.frozen_at)}. ` : "", h("button", { class: "btn btn-ghost", type: "button", style: "height:28px;padding:0 12px;font-size:13px", onclick: openUnfreeze, text: "Unfreeze" }))
    : `Issuer: ${d.status.issuer}`;
  stat("stat-state", "Status", stateVal, sub, { tone: frozen ? "frozen" : "ok" });
  $("kill").disabled = frozen;
}

function renderPending(d) {
  const list = d.pending;
  $("pending-count").textContent = list.length ? String(list.length) : "";
  const box = $("pending"); box.replaceChildren();
  if (!list.length) { box.append(h("p", { class: "empty", text: "Nothing to approve. New merchants and payments over your approval threshold will show up here." })); return; }
  for (const p of list) {
    const hw = p.approval.level === "hardware";
    box.append(h("div", { class: "request" },
      h("div", {},
        h("div", { class: "who", text: p.merchant }),
        h("div", { class: "meta" }, `Card cap ${money(p.card_cap_usd)}`, p.approval.expires_at ? ` · expires ${when(p.approval.expires_at)}` : ""),
      ),
      h("div", { class: "amount", text: money(p.amount_usd) }),
      h("div", { class: "chips" }, p.approval.reasons.map((r) => h("span", { class: `chip${r === "above_hardware_threshold" ? " chip-warn" : ""}`, text: REASON_LABEL[r] ?? r }))),
      h("div", {}),
      h("div", { class: "quote", text: p.description ?? "" }),
      h("div", { class: "actions" },
        h("button", { class: "btn btn-ghost", type: "button", onclick: () => openDecision(p, "reject"), text: "Reject" }),
        hw
          ? h("button", { class: "btn btn-primary", type: "button", disabled: true, title: "Approve with your hardware wallet from the CLI: paygent approve " + p.payment_id, text: "Needs hardware wallet" })
          : h("button", { class: "btn btn-primary", type: "button", onclick: () => openDecision(p, "approve"), text: `Approve ${money(p.amount_usd)}` }),
      ),
    ));
  }
}

function renderPayments(d) {
  const t = $("payments"); t.replaceChildren();
  if (!d.payments.length) { t.append(h("tbody", {}, h("tr", {}, h("td", { class: "empty", text: "No payments yet. Ask your agent to buy something." })))); return; }
  t.append(h("thead", {}, h("tr", {},
    h("th", { text: "When" }), h("th", { text: "Merchant" }), h("th", { class: "num", text: "Amount" }),
    h("th", { text: "Card" }), h("th", { text: "Status" }), h("th", { text: "What for" }))));
  t.append(h("tbody", {}, d.payments.map((p) => h("tr", {},
    h("td", { text: when(p.created_at) }),
    h("td", { text: p.merchant }),
    h("td", { class: "num", text: money(p.settled_usd ?? p.amount_usd) }),
    h("td", { text: p.card ? `•••• ${p.card.last4}` : "" }),
    h("td", {}, h("span", { class: `status s-${p.status}`, title: p.deny_reason ? (DENY_LABEL[p.deny_reason] ?? p.deny_reason) : "", text: STATUS_LABEL[p.status] ?? p.status }),
      p.deny_reason ? h("div", { class: "hint", text: DENY_LABEL[p.deny_reason] ?? p.deny_reason }) : ""),
    h("td", { class: "desc", title: p.description, text: p.description }),
  ))));
}

function renderPolicy(d) {
  if (policyDirty) return;
  const p = d.policy;
  const f = $("policy"); f.replaceChildren();
  const usd = (name, label, value) => h("label", { class: "field" }, h("span", { text: label }),
    h("div", { class: "prefix" }, h("span", { text: "$" }), h("input", { name, inputmode: "decimal", value, autocomplete: "off", pattern: "\\d+(\\.\\d{1,2})?", required: true })));
  const num = (name, label, value, min, max) => h("label", { class: "field" }, h("span", { text: label }),
    h("input", { name, type: "number", min, max, step: "1", value, required: true }));
  const list = (name, label, values) => h("label", { class: "field wide" }, h("span", { text: label }),
    h("textarea", { name, spellcheck: "false", placeholder: "one domain per line" }, values.join("\n")));
  f.append(
    h("div", { class: "form-grid" },
      usd("limits.per_transaction_usd", "Per payment", p.limits.per_transaction_usd),
      usd("approval.require_above_usd", "Ask me above", p.approval.require_above_usd),
      usd("limits.daily_usd", "Per day", p.limits.daily_usd),
      usd("limits.monthly_usd", "Per month", p.limits.monthly_usd),
      usd("limits.per_merchant_daily_usd", "Per merchant per day", p.limits.per_merchant_daily_usd),
      num("limits.max_payments_per_hour", "Payments per hour", p.limits.max_payments_per_hour, 1, 1000),
      h("label", { class: "field check" }, h("input", { type: "checkbox", name: "approval.require_for_new_merchant", checked: p.approval.require_for_new_merchant }),
        h("span", { text: "Ask me before paying a merchant for the first time" })),
      list("merchants.allow", "Trusted merchants (skip the first-time check)", p.merchants.allow),
      list("merchants.deny", "Never pay", p.merchants.deny),
    ),
    h("div", { class: "form-actions" },
      h("button", { class: "btn btn-ghost", type: "button", onclick: () => { policyDirty = false; renderPolicy(last); }, text: "Discard" }),
      h("button", { class: "btn btn-primary", type: "submit", text: "Save changes" })),
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
    const summary = Object.entries(e.data ?? {}).filter(([, val]) => val !== null && val !== undefined)
      .map(([k, val]) => `${k}=${typeof val === "object" ? JSON.stringify(val) : val}`).join("  ");
    ol.append(h("li", {}, h("span", { class: "seq", text: `#${e.seq}` }), h("span", { class: "type", title: when(e.ts), text: e.type }), h("span", { class: "data", text: summary.slice(0, 400) })));
  }
}

function render(d) {
  last = d;
  renderStats(d); renderPending(d); renderPayments(d); renderPolicy(d); renderAudit(d);
  $("app").setAttribute("aria-busy", "false");
}

async function refresh() {
  if (!token()) { setConn("down", "No dashboard token"); showNoToken(); return; }
  try {
    render(await api("GET", "/api/overview"));
    setConn("live", "Connected");
  } catch (e) {
    setConn("down", e.status === 401 ? "Link expired" : e.message.includes("daemon not running") ? "Daemon not running" : "Disconnected");
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
    okClass: approve ? "btn-primary" : "btn-danger",
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
  okClass: "btn-danger",
  needsPass: false,
  action: async () => {
    const r = await api("POST", "/api/kill", { confirm: "kill" });
    toast(r.owner_action ?? "Frozen. All open cards are frozen.");
  },
}));

$("app").addEventListener("input", (e) => { if (e.target.closest("#policy")) policyDirty = true; });
$("app").addEventListener("change", (e) => { if (e.target.closest("#policy")) policyDirty = true; });
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
