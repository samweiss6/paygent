# Paygent architecture

Status: draft v0.1 (2026-11-17). Applies to the MVP in this repository. Everything here runs in test mode: Base Sepolia testnet and provider sandboxes only.

## 1. What Paygent is

Paygent is a local daemon that an AI agent talks to over MCP. The owner keeps a non-custodial smart wallet holding USDC and grants Paygent a narrow, revocable, on-chain spending allowance. When the agent wants to buy something, it asks Paygent for a payment. Paygent checks the request against the owner's policy, pulls the exact amount through the allowance, has a card-issuing provider create a single-use, merchant-locked virtual card for that amount, and places the card at checkout without showing the card number to the agent.

There is no Paygent-operated service. Each install is one process on the owner's machine (or server), using the owner's wallet and the owner's provider accounts.

## 2. Components

```
                         owner (human)
                 CLI / local approval page (owner key)
                               │  Unix socket 0600 / localhost + owner token
┌──────────────────────────────┼──────────────────────────────────────────────┐
│ paygentd (single Node.js process, the "core")                               │
│                              ▼                                              │
│  ┌────────────┐   ┌────────────────┐   ┌─────────────┐   ┌───────────────┐  │
│  │ MCP server │──▶│ Payment service│──▶│ Policy      │   │ Audit log     │  │
│  │ (agent API)│   │ (orchestrator) │   │ engine      │   │ (hash chain,  │  │
│  └────────────┘   └───────┬────────┘   │ (pure fn)   │   │ append-only)  │  │
│   stdio or                │            └─────────────┘   └───────────────┘  │
│   127.0.0.1 HTTP          │   ┌──────────┐ ┌────────────┐ ┌──────────────┐  │
│   + bearer token          ├──▶│ Ledger   │ │ Keystore   │ │ Card vault   │  │
│                           │   │ (SQLite) │ │ (scrypt +  │ │ (PAN sealed, │  │
│                           │   └──────────┘ │ AES-GCM)   │ │ never to MCP)│  │
│                           │                └────────────┘ └──────┬───────┘  │
│                           │   ┌──────────────────────┐           │          │
│                           ├──▶│ Spend authority      │    ┌──────▼───────┐  │
│                           │   │ (spender key, viem)  │    │ Checkout     │  │
│                           │   └──────────┬───────────┘    │ injector     │  │
│                           │              │                │ (CDP / human │  │
│                           ▼              │                │ reveal)      │  │
│                 ┌───────────────────┐    │                └──────────────┘  │
│                 │ Adapter host      │    │                                  │
│                 │ (restricted API)  │    │                                  │
│                 └───┬───────────┬───┘    │                                  │
└─────────────────────┼───────────┼────────┼──────────────────────────────────┘
          built-in    │           │ child process, Node --permission
          (in-proc)   ▼           ▼        ▼
            issuer/funding    third-party      Base Sepolia:
            adapters          adapters         SpendPermissionManager
                                               0xf85210B21cC50302F477BA56686d2019dC9b67Ad
```

| Component | Responsibility | Holds secrets? |
|---|---|---|
| MCP server | Exposes agent tools. Validates input with zod. Has no tool that changes policy, approves, reveals a PAN, or reads keys. | No |
| Owner control plane | `paygent` CLI plus a localhost approval page. Approves pending payments, edits policy, runs the kill switch. Authenticates with the owner key, which the agent never has. | Owner signing key (encrypted, needs passphrase) |
| Payment service | State machine for one payment: validate → decide → reserve → fund → issue → checkout → settle. Enforces idempotency. | No (calls into the others) |
| Policy engine | Pure function `decide(request, policy, ledgerView, now)`. No I/O, so it is easy to test and review. | No |
| Ledger | SQLite (`node:sqlite`, no native dependency). Payments, reservations, idempotency keys, merchant history. | No |
| Audit log | JSONL, one entry per event, each entry carrying the SHA-256 of the previous entry. `paygent audit verify` detects edits or truncation in the middle of the log. | No |
| Keystore | Encrypted file (scrypt N=2^17, AES-256-GCM). Holds the spender private key and provider API keys. Unlocked at start with a passphrase (interactive, or a Docker secret file). | Yes |
| Card vault | Holds issued card details, sealed in memory, plus at rest with a key derived from the keystore. Only the checkout injector and the owner reveal page can read them. | Yes (PANs) |
| Spend authority | Talks to Coinbase's SpendPermissionManager. Calls `spend` for exact amounts and `revokeAsSpender` for the kill switch. | Uses the spender key |
| Adapter host | Gives each adapter a restricted context: its own config and API key, an HTTP client limited to declared hosts, a logger that drops secrets. No keystore, policy, ledger, or wallet access. | Passes each adapter its own key only |

## 3. Data flow: one purchase

1. The agent calls `request_payment({merchant: "example-store.com", amount_usd: "23.40", description, idempotency_key})`.
2. The MCP server validates the shape and passes the request to the payment service. The request carries no trust: whatever caused the agent to ask (a web page, an email) is irrelevant, because the decision depends only on policy.
3. Idempotency: the same `idempotency_key` returns the existing payment. The same key with different parameters is rejected.
4. The policy engine returns `approve`, `require_approval`, or `deny`, plus a list of reasons. Everything is written to the audit log.
5. If approval is required, the payment waits as `pending_approval`. The owner approves with `paygent approve <id>` (signed with the owner key) or on the local approval page. Above `hardware_approval_threshold_usd`, the approval must be signed by a separate signer, such as a hardware wallet or the owner's root wallet, using an EIP-712 message that Paygent verifies but cannot produce.
6. Reserve: the amount is counted against the daily and monthly caps before any money moves, so two concurrent requests can't both slip under a cap.
7. Fund: the spend authority calls `SpendPermissionManager.spend(permission, amount)`. The contract enforces the per-period allowance on-chain. USDC moves from the owner's smart wallet to the spender address. The funding adapter then forwards the amount to the issuer's funding address, or pays the issuer directly for crypto-native issuers.
8. Issue: the issuer adapter creates a card of type `single_use`, locked to the merchant, with a hard cap of `amount × (1 + tolerance)` and an expiry of at most 24 hours. Card details go straight into the card vault. The agent receives only `payment_id`, `status`, `last4`, and the cap.
9. Checkout, one of three:
   - `checkout_fill` (default for agents with a browser): Paygent connects to the agent's browser over the Chrome DevTools Protocol, checks that the page origin matches the card's merchant, and types the card fields itself. The values never pass through MCP.
   - Owner reveal: the owner opens a one-time localhost page from the CLI and pastes the details by hand.
   - `reveal_card_to_agent`: off by default. It needs a policy flag, and even then it only works for a single-use, merchant-locked card under the cap, which is gone after one charge.
10. Settle: the issuer webhook (or polling, in the MVP) marks the payment `settled` or `declined`. When a card expires unused, its balance stays with the owner's issuer account and the cap reservation is released.

## 4. Deployment model

- One command: `docker compose up` (image built locally from this repo, read-only root FS, non-root user, no published ports except `127.0.0.1:7402`). Or without Docker: `npm ci && npx paygent setup && npx paygent start`.
- First-run setup (`paygent setup`) is a terminal wizard. It:
  1. creates `~/.paygent/` with mode 0700;
  2. asks for a passphrase and creates the keystore;
  3. generates the spender key (for the on-chain mode) and the owner signing key, both encrypted;
  4. writes a conservative default policy and signs it with the owner key;
  5. picks the authority (`mock` for a dry run, or `base-sepolia`) and an issuer adapter (`mock`, or a provider sandbox);
  6. for `base-sepolia`, prints the exact SpendPermission struct for the owner to approve **in their own wallet**, then checks on-chain that it is approved;
  7. prints the MCP config snippet to paste into the agent.
- Agents connect over stdio (the agent launches `paygent mcp`, and that process hands off to the daemon through the owner-only Unix socket) or over HTTP on `127.0.0.1:7402/mcp` with a bearer token. Binding to anything other than loopback refuses to start unless `remote.enabled: true` is set in a signed policy and TLS plus token authentication are configured.
- State lives entirely in `~/.paygent/`: `keystore.json`, `policy.json`, `policy.sig`, `ledger.db`, `audit.log`, `config.json`.

## 5. Non-custodial authority model

The options I considered:

| Option | On-chain limit | Revocable by owner | Revocable by Paygent (kill switch) | Practical today | Verdict |
|---|---|---|---|---|---|
| Hot EOA key holding funds | None | Only by moving funds | Yes | Yes | Rejected: full access |
| ERC-20 `approve(spender, X)` | Total only, no period | Yes | No | Yes | Too coarse |
| **Coinbase Spend Permissions** (SpendPermissionManager on Base) | Per-period allowance, start/end time, single token | Yes (`revoke`) | Yes (`revokeAsSpender`) | Yes: Base and Base Sepolia, documented in CDP | **Chosen** |
| ERC-7715 / ERC-7710 session keys (MetaMask delegation, etc.) | Rich (caveats) | Yes | Depends on wallet | Draft ERCs, uneven wallet support | Adapter later |
| Safe + Allowance module | Per-period | Yes | Partly | Yes | Good alternative; heavier setup |
| MPC policy wallets (Coinbase Agentic Wallets) | Enforced by provider, not on-chain | Yes | Yes | Yes | Custodial-ish provider trust; not chosen |

Chosen design:

- The owner's **root key** lives only in the owner's wallet (Coinbase Smart Wallet, or any smart account with spend permissions enabled). Paygent never sees it.
- Paygent generates a **spender key** on the owner's machine. The owner approves a SpendPermission: `token = USDC`, `allowance` = the policy's daily cap, `period = 86400`, `end` = no more than 90 days out. Even a fully compromised install can move at most `allowance` per day until the owner revokes it, and nothing after `end`.
- The on-chain allowance is set **at or below** the policy's daily cap. The off-chain policy then adds the finer rules (per-transaction cap, merchant lists, approvals, monthly cap) that the contract can't express.
- `spend` moves funds to the spender address. That address belongs to the owner's own install, on the owner's machine, and Paygent forwards funds to the issuer in the same operation. Balances that sit at the spender are swept back to the owner's wallet by `paygent sweep` and on the kill switch.
- The spender key is the "narrowly scoped, expiring session credential". It expires on-chain at `end`.
- Kill switch (`paygent kill`): (1) set the frozen flag first, so the daemon rejects all payment calls; (2) call `revokeAsSpender`; (3) freeze every open card through the issuer adapters; (4) sweep the spender balance back to the owner; (5) write the audit entry. Step 1 needs no network, so a misbehaving agent can't race it. The owner can always also revoke from their own wallet, without Paygent.

## 6. Provider adapter interface

Two adapter kinds, both deliberately small (full contract in `docs/adapter-authoring.md`, code in `src/adapters/types.ts`):

```ts
interface IssuerAdapter {
  id: string; kind: "issuer"; displayName: string;
  capabilities: { singleUse: boolean; merchantLock: boolean; perCardCap: boolean;
                  expiry: boolean; freeze: boolean; fundingCurrency: "USD" | "USDC" };
  createCard(req: { amountCents: number; merchant: string; expiresAt: string;
                    idempotencyKey: string; memo: string }): Promise<IssuedCard>;
  freezeCard(providerCardId: string): Promise<void>;
  getCardStatus(providerCardId: string): Promise<CardStatus>;
  listOpenCards(): Promise<string[]>;
}
interface FundingAdapter {
  id: string; kind: "funding";
  fund(req: { amountUsdcUnits: bigint; issuerId: string; idempotencyKey: string })
    : Promise<{ reference: string }>;
}
```

The adapter gets an `AdapterContext`: `{ config, apiKey, http (host-allowlisted fetch), log (redacting), testMode: true }`. It never gets the keystore, the policy, the ledger, the audit log, or the wallet. The core checks what each adapter returns: if `createCard` returns a card without the requested lock or cap, the core freezes it and fails the payment, because a claim in the capabilities isn't enough.

Third-party adapters (anything outside `src/adapters/builtin/`) run in a child process started with Node's permission model (`--permission`, filesystem reads limited to the adapter's own directory, no writes, no child processes, no workers) and talk to the core over JSON-RPC on stdio. Node's permission model doesn't restrict network access, so outbound hosts are listed in the adapter's manifest and the owner approves them at install, and the risk is documented in the threat model.

## 7. Design decisions and trade-offs

| # | Decision | Why | Trade-off |
|---|---|---|---|
| D1 | TypeScript on Node 24, run with built-in type stripping (no build step) | MCP SDK and viem are first-class in TS; no bundler means less supply chain to audit | Requires Node ≥ 22.18 / 24 |
| D2 | Three runtime dependencies: `@modelcontextprotocol/sdk`, `zod`, `viem`. Pinned exact versions, lockfile committed | Keeps the core reviewable | Some hand-written code (keystore, audit chain) instead of libraries |
| D3 | SQLite via `node:sqlite` | No native build, single file, transactions for cap reservations | `node:sqlite` is still marked experimental in Node 24 |
| D4 | Encrypted keystore file as the default secret store; OS keychain as a later option | Works the same in Docker, on Linux servers, and on macOS | Needs a passphrase at start; on a headless server it comes from a Docker secret file |
| D5 | Policy is a signed file, changed only through the owner CLI | The agent has no tool to change it; edits on disk are detected by the signature check and freeze the daemon | A same-user host compromise can still replace both the file and the key; the on-chain cap is the backstop |
| D6 | Single-use, merchant-locked, capped, ≤24 h cards for every payment | Limits the value of any leaked card to one charge at one merchant | More cards issued; some issuers charge per card; recurring subscriptions need a separate later design |
| D7 | Credential injection over CDP instead of returning PANs | Keeps PANs out of the model context, logs, and traces | Only works with agents that drive a Chromium browser; others fall back to the owner reveal page |
| D8 | Stdio and loopback HTTP only by default | Most agents run on the same machine | Remote agents need explicit TLS plus token setup |
| D9 | Apache-2.0 licence | Permissive, with an explicit patent grant and a NOTICE mechanism suited to a payments project that companies may embed; compatible with MIT/BSD dependencies | Not copyleft: forks need not publish changes |
| D10 | `mock` authority and `mock` issuer ship in the core | A new user can run the full flow, and tests can run, with no accounts | Must be impossible to mistake for real money: banner in every response, `test_mode: true` field |
| D11 | Live mode is not implemented in v0.1 | The brief says test mode only; provider terms are unresolved (see `docs/03-provider-comparison.md`) | Users can't actually buy anything with v0.1 |

## 8. MCP surface (agent-facing)

| Tool | Purpose | Side effects |
|---|---|---|
| `get_balance` | Remaining on-chain allowance this period, wallet USDC balance, remaining daily and monthly policy caps | None |
| `list_policies` | Read-only view of the active policy (limits, merchant lists, approval rules) so the agent can plan | None |
| `request_payment` | Ask to pay a merchant an amount; returns a decision and a `payment_id` | May move testnet funds and issue a card |
| `get_payment_status` | Status, masked card (`last4`), cap, expiry, settlement state | None |
| `checkout_fill` | Fill the card form in the agent's browser over CDP for an issued payment | Types card details into a page whose origin matches the merchant |
| `cancel_payment` | Cancel a pending or unused payment and freeze its card | Freezes a card |

The MCP spec in use is the 2026-07-28 revision through `@modelcontextprotocol/sdk` 1.32.x. Tools carry `annotations` (`readOnlyHint`, `destructiveHint`) so clients can prompt for confirmation, but Paygent never depends on the client to do so.

## 9. Out of scope for v0.1

Live funds; recurring subscriptions; refunds back to the wallet; multi-user installs; remote MCP with OAuth (the 2026-07-28 spec's authorization flow); OS keychain integration; signed release pipeline (documented, not wired up).
