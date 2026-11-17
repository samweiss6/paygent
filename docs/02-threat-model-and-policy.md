# Threat model and spend-policy specification

Status: draft v0.1 (2026-11-17). Written before the payment code; the code in `src/` implements the controls marked **[MVP]**. Controls marked **[later]** are design commitments that are not yet built.

## Part A: Threat model

### A.1 Assets

| Asset | Why it matters |
|---|---|
| A1. Owner's wallet funds (USDC) | Direct loss |
| A2. Spender key (session credential) | Can call `spend` up to the on-chain allowance until revoked or expired |
| A3. Card details (PAN, CVV, expiry) | Can be charged anywhere the card's controls allow |
| A4. Provider API keys | Can create cards or move money inside the owner's provider account, within that provider's limits |
| A5. Policy and approval authority | Controls what the agent may spend |
| A6. Audit log integrity | Needed to detect and dispute misuse |
| A7. Owner identity data | Paygent never has it (KYC happens directly with providers); listed so nobody adds it later |

### A.2 Trust boundaries

1. Agent ↔ MCP server. Everything from the agent is untrusted input.
2. Core ↔ adapters. Adapters are untrusted code that returns untrusted data.
3. Core ↔ chain and provider APIs. Responses are validated; the chain is the authority for allowance.
4. Owner control plane ↔ core. Authenticated by the owner signing key (passphrase) or a hardware/root-wallet signature.
5. Host OS. If the host is fully compromised, only the on-chain limits and the provider's own controls still hold.

### A.3 Adversaries and controls

#### T1. Malicious agent
The agent itself (or whoever controls it) is trying to spend more than allowed, or to get card numbers.

| Attack | Control | Status |
|---|---|---|
| Ask for amounts above caps | Policy engine checks per-transaction, daily, and monthly caps before any funds move; on-chain allowance enforces the daily cap independently | [MVP] |
| Split one purchase into many small ones | Daily/monthly caps count reservations, not just settled payments; optional per-merchant daily cap; velocity limit (max payments per hour) | [MVP] |
| Race concurrent requests under a cap | Reservations are written inside a SQLite transaction before funding; caps are computed from reservations | [MVP] |
| Edit its own policy | No MCP tool writes policy; policy file is signed with the owner key and the daemon freezes on a bad signature | [MVP] |
| Approve its own request | Approvals need the owner key (passphrase) or a hardware signature; the MCP token can't approve; approval endpoints aren't on the MCP server | [MVP] owner key; [MVP] EIP-712 signature check above threshold |
| Get the PAN | No MCP tool returns it by default; `checkout_fill` types it into the browser; card is single-use, merchant-locked, capped, ≤24 h | [MVP] |
| Use `checkout_fill` to type the PAN into its own page | Injector checks the page's origin against the card's merchant (registrable domain) before typing; refuses otherwise | [MVP] |
| Replay a request | Idempotency key; the same key with different parameters is rejected | [MVP] |
| Claim a fake merchant name to dodge the deny list | Merchant is normalized to a registrable domain; card is locked to the first merchant that charges it (issuer-side), and settlement merchant is compared to the requested one, with mismatch → card frozen and alert | [MVP] normalization; [later] settlement comparison for each issuer |
| Flood requests to cause approval fatigue | Velocity limit; pending approvals per hour cap; approval page groups requests | [MVP] velocity; [later] grouping |
| Hit the kill switch | Allowed: it only ever reduces authority. Kill switch is not on MCP anyway | n/a |

#### T2. Prompt-injected agent
A legitimate agent that has read a hostile web page, email, or tool result.

Same controls as T1, because Paygent does not try to judge intent. Additional points:
- Request fields (`description`, `merchant`) are stored and shown to the owner as untrusted text: escaped in the approval page, quoted in the CLI, length-limited. [MVP]
- New merchants need owner approval by default, which is where most injection-driven purchases ("buy this gift card at evil.example") stop. [MVP]
- Denied requests return a generic reason category to the agent, not the policy internals, and the exact rule is in the audit log. Reasons are things like `exceeds_per_transaction_limit` (the agent can already see limits via `list_policies`, so this is not secret), never free text that could be read back as instructions. [MVP]
- Default deny list covers categories commonly used to cash out: gift cards, prepaid cards, crypto exchanges, money transfer, gambling. [MVP] (as a domain list plus keyword check on the description; the issuer's MCC blocking is stronger and is used where the adapter supports it [later])

#### T3. Malicious adapter
A third-party adapter (or a compromised update of one) trying to steal keys, funds, or card data, or to lie about card controls.

| Attack | Control | Status |
|---|---|---|
| Read the keystore or other adapters' keys | Third-party adapters run in a separate process under Node's permission model with fs reads limited to their own directory; they get only their own API key | [MVP] |
| Exfiltrate over the network | Hosts declared in manifest and approved by the owner; built-in adapters use the allowlisted `http` client. **Gap:** Node's permission model doesn't block raw network access, so a child-process adapter can open arbitrary sockets. Mitigation: run third-party adapters only from reviewed sources; Docker network egress allowlist [later] | partial |
| Return a card without single-use/lock/cap | Core verifies the returned card's controls; mismatch → freeze and fail | [MVP] |
| Report a different amount or merchant | Core uses its own values for cap; settlement data is cross-checked | [MVP] cap; [later] settlement |
| Steal the PAN it just issued | Unavoidable: the issuer adapter sees the cards it creates. The adapter is the owner's own issuer integration; the card's tight controls limit the damage. Adapters can't read other cards' PANs | accepted, documented |
| Send money to its own address | Funding adapters get an amount and the issuer id; the destination address comes from signed config, not from the adapter; core performs the on-chain transfer | [MVP] |
| Log secrets | Adapter logger redacts PAN-like and key-like strings; adapter stdout/stderr is not written to the audit log | [MVP] |

#### T4. Compromised host
An attacker with code execution as the user who runs Paygent.

This is the case the design can't fully defend in software, so it bounds the damage:
- The root key is never on the host (it lives in the owner's wallet or hardware). [MVP]
- The spender key can move at most the on-chain `allowance` per `period`, and nothing after `end`. With defaults that is $50/day for at most 30 days. [MVP]
- Keystore is encrypted; an attacker who can read files but not memory or keystrokes doesn't get keys. An attacker who can read memory of the running daemon gets the unlocked spender key and provider keys. [accepted]
- Provider API keys: owners should set account-level limits at the provider too (documented in README). [docs]
- Above the hardware threshold, approvals need a signature the host can't produce. [MVP]
- The owner can revoke from their wallet on another device, without the host. [MVP, it's the contract's behavior]
- Audit log hash chain makes tampering visible if a copy of the head hash is kept elsewhere (`paygent audit head` prints it; the owner can record it). [MVP]

#### T5. Malicious dependency
A dependency (or a transitive one) is compromised.

- Three direct runtime dependencies, pinned to exact versions at least two weeks old at release, lockfile committed, `npm ci --ignore-scripts` in Docker and docs. [MVP]
- `npm audit` and lockfile review in CI; Dependabot/Renovate with a cooling-off period. [later: CI config provided, not run]
- Releases signed (Sigstore / npm provenance) and container images signed with cosign. [later, documented in SECURITY.md]
- Docker image: non-root, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`. [MVP]
- A compromised dependency in the core process has the same power as T4; the same bounds apply.

#### T6. Others
- **Network attacker:** loopback-only by default; remote mode requires TLS. RPC endpoint responses are only used for reads; writes are signed transactions whose effect is bounded by the contract. [MVP]
- **Malicious merchant:** single-use cards, so a merchant can't charge again later. [MVP]
- **Other local users on a shared machine:** `~/.paygent` is 0700, files 0600, Unix socket 0600, HTTP requires a bearer token even on loopback. [MVP]
- **Owner mistakes:** conservative defaults; `paygent doctor` flags risky settings (remote enabled, high caps, agent reveal enabled). [MVP]

### A.4 Residual risks the owner must accept
1. A compromised host can spend up to the on-chain allowance per period until revocation.
2. The issuer (and its adapter) sees every card it issues.
3. A browser-driving agent could, after `checkout_fill`, read the filled field values from the DOM. Mitigation: card is single-use and merchant-locked; for stronger isolation the owner reveal path keeps the PAN out of the agent's browser entirely. This is a real gap; the long-term fix is network-tokenized agent credentials (Visa Intelligent Commerce / Mastercard Agent Pay) where the merchant never needs a raw PAN.
4. Node's permission model doesn't sandbox network access for adapters.

## Part B: Spend-policy specification

### B.1 Where policy is enforced

| Layer | What it enforces | Bypassable by |
|---|---|---|
| L1 On-chain (SpendPermissionManager) | Token, allowance per period, start/end | Nobody without the owner's root key |
| L2 Issuer card controls | Single-use, merchant lock, card cap, expiry, MCC blocks where supported | Issuer account holder (owner's provider API key) |
| L3 Paygent policy engine | Everything below | A compromised host |
| L4 Owner/hardware approval | Payments above thresholds | Nobody without the owner's key or hardware signer |

### B.2 Policy document

Stored at `~/.paygent/policy.json`, signed (`policy.sig`, Ed25519) by the owner key. Amounts are decimal strings in USD, converted to integer cents internally.

```json
{
  "version": 1,
  "limits": {
    "per_transaction_usd": "25.00",
    "daily_usd": "50.00",
    "monthly_usd": "200.00",
    "max_payments_per_hour": 5,
    "per_merchant_daily_usd": "50.00"
  },
  "approval": {
    "require_for_new_merchant": true,
    "require_above_usd": "10.00",
    "hardware_required_above_usd": "100.00",
    "hardware_signer_address": null,
    "approval_ttl_minutes": 30
  },
  "merchants": {
    "allow": [],
    "deny": ["*.giftcards.com", "*.coinbase.com", "*.binance.com", "*.paypal.com", "*.venmo.com", "*.westernunion.com"],
    "allow_only_listed": false
  },
  "blocked_keywords": ["gift card", "giftcard", "prepaid card", "crypto", "bitcoin", "wire transfer", "money order", "casino", "betting"],
  "cards": {
    "max_lifetime_minutes": 60,
    "amount_tolerance_percent": 5,
    "amount_tolerance_max_usd": "2.00",
    "allow_reveal_to_agent": false
  },
  "remote": { "enabled": false }
}
```

### B.3 Decision algorithm

`decide(request, policy, ledger, now) → { outcome: "approve" | "require_approval" | "deny", reasons: Reason[], approval_level: "none" | "owner" | "hardware" }`

Evaluated in this order; the first `deny` ends evaluation:

1. **Frozen check.** If the kill switch is engaged, or the policy signature is invalid → `deny: frozen`.
2. **Shape.** Amount > 0, at most 2 decimals, ≤ $1,000,000; merchant parses as a domain (no IPs, no localhost, no userinfo); description ≤ 280 chars. Else `deny: invalid_request`.
3. **Deny list.** Merchant matches `merchants.deny` (exact or `*.` suffix on the registrable domain) → `deny: merchant_denied`.
4. **Keywords.** Description or merchant contains a blocked keyword (case-insensitive) → `deny: blocked_category`.
5. **Allow-only.** If `allow_only_listed` and merchant not in `allow` → `deny: merchant_not_allowed`.
6. **Per-transaction.** Amount > `per_transaction_usd` → `deny: exceeds_per_transaction_limit`.
7. **Velocity.** Payments created in the last hour (any status except `denied`) ≥ `max_payments_per_hour` → `deny: velocity_limit`.
8. **Daily cap.** Today's reserved + settled (UTC day) + amount > `daily_usd` → `deny: exceeds_daily_limit`.
9. **Monthly cap.** Same for the calendar month → `deny: exceeds_monthly_limit`.
10. **Per-merchant daily.** → `deny: exceeds_merchant_daily_limit`.
11. **On-chain headroom.** Amount > remaining on-chain allowance for the current period → `deny: insufficient_allowance`. (Checked in the payment service just before funding, because it needs a chain read.)
12. **Approval level.** Start at `none`. If amount > `hardware_required_above_usd` → `hardware`. Else if merchant is new (no previously settled or owner-approved payment) and `require_for_new_merchant` → `owner`. Else if amount > `require_above_usd` → `owner`. Merchants in `allow` skip the new-merchant rule but not the amount rules. Outcome is `require_approval` if level ≠ `none`, else `approve`.

Invariants (tested):
- No sequence of `request_payment` calls can cause reserved + settled to exceed `daily_usd` or `monthly_usd`.
- No input to any MCP tool changes the policy, the frozen flag (except to... nothing: freezing is owner-only too), or approval state.
- Approval for payment X can't be reused for payment Y (approval signs the payment id, amount, and merchant).
- An approval for a hardware-level payment signed with only the owner key is rejected.
- Limits only get stricter between policy load and decision: a policy reload during a request uses the stricter of old and new.

### B.4 Defaults rationale

- $25/transaction, $50/day, $200/month: enough to test real purchases, small enough that a mistake is an annoyance.
- Owner approval for every new merchant and for anything over $10: the agent does routine re-orders unattended, and anything novel gets a human glance.
- Hardware/root signer over $100: the host alone can never approve a large payment.
- 60-minute card lifetime, 5% / $2 tolerance: covers tax and shipping changes between quote and checkout without leaving usable cards around.
- On-chain allowance = daily cap, permission end = 30 days: the worst case for a compromised host is bounded and expires on its own.

### B.5 Changing policy

Only `paygent policy edit` / `paygent policy set <path> <value>` (needs passphrase, re-signs). Loosening changes (higher limit, removing a deny entry, enabling reveal or remote) print a diff and require typing the word `loosen`. On-chain allowance changes require a new SpendPermission approved in the owner's wallet; Paygent prints the struct but can't approve it.
