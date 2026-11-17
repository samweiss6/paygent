# Provider comparison and MVP recommendation

Researched 2026-11-17, revised the same day for the fiat-funding scope change. Not legal advice. Facts quoted from a provider's own docs or terms are cited. Anything from a third-party blog, an aggregator, or vendor marketing is marked *(unverified)*. Re-check everything here before any live use.

## 1. Summary

- **Paygent supports three funding paths behind one agent API:** (a) fiat on-ramp → the owner's own wallet → card, (b) direct fiat → card with no crypto, and (c) a crypto wallet the owner already has. The agent's tools are identical on all three; only `get_balance` reports which path is active.
- **Recommendation for the MVP: path (b), direct fiat.** For a US consumer self-hoster it has fewer accounts, fewer KYC steps, lower and more predictable fees, and the best per-card controls, and it needs no crypto knowledge. The MVP runs it against the `mock` issuer and the **Lithic sandbox**.
- **The only consumer-facing direct-fiat provider I found, Privacy.com, has terms that as written forbid this use.** Its General Terms (last updated 2023-09-06) prohibit using the service "in conjunction with automated purchasing software programs". Its Payment Terms say "Virtual Cards are not issued to you and are not for consumer use" and that Payment Services "may only be used for business purposes". Privacy.com also markets agent use at agents.privacy.com and runs a hosted MCP endpoint, but I found no agent-specific terms that override the restriction. **Live path (b) is blocked until Privacy.com confirms in writing that owner-configured, self-hosted agent use is allowed.**
- **The next-best option if Privacy.com says no is not a clean one.** Lithic and Stripe Issuing are business programs, and Stripe's terms limit spend to business purposes. Path (a) needs a card issuer that accepts USDC from an individual, and the only one I found with an agent API (Laso Finance) publishes no sandbox, doesn't check identity on card orders, and doesn't lock cards to a merchant. Section 6 sets out what would have to be true.
- **The crypto path is still needed** for the one property fiat can't provide: a spending cap enforced outside the host that a compromised install can't raise (section 5).

## 2. Head to head: (a) on-ramp → wallet → card vs (b) direct fiat → card

For a US consumer running Paygent on their own machine, with no business entity.

| | (a) Fiat on-ramp → own wallet → card | (b) Direct fiat → card |
|---|---|---|
| Accounts the owner needs | On-ramp (or exchange) account + smart wallet + a card issuer that accepts USDC | One card-issuer account with a linked bank account or debit card |
| KYC steps | 1–2: on-ramp KYC always; issuer KYC depends on issuer (Laso's order endpoints check none, see §3) | 1: issuer's identity check (Privacy: "must successfully pass the Privacy Customer Identification Program (CIP) before they can transact") |
| Total fees, typical $20 purchase | On-ramp: Coinbase Onramp lists no developer fee; end-user fees depend on payment method (a Coinbase help page lists guest debit at ~5%, "estimates and subject to change"); ACH figures from aggregators only *(unverified)*. Plus Base gas (cents; sponsorable). Plus issuer fees (Laso claims none, *vendor claim*). Plus risk of forfeiting unused prepaid balance (Laso: "remaining balance is forfeited" at 6 months) | Privacy.com: API needs a paid plan, Plus $5/mo or Pro $10/mo (pricing page); "no fees on domestic transactions" (General Terms footnote, Personal plan); 3% foreign fee on Plus. Bank/debit funding fees not stated *(unverified)* |
| Individual without a business entity | On-ramp: yes for consumers buying in their own Coinbase account. Integrating an on-ramp API is another matter: Stripe requires an approved onramp application "including in sandboxes"; MoonPay issues production keys after "KYB and product review"; Coinbase Onramp needs a CDP project and backend session tokens, starts in "trial mode" and needs an application for full access (entity requirement not stated) | Privacy.com: sign-up yes, but Payment Terms say business purposes only (conflict, §4). Lithic: sandbox self-serve, live "contact Sales". Stripe Issuing: "cards must be used for business purposes" |
| Terms on self-hosted / automated / AI-agent use | Coinbase: CDP and Onramp are built for developer integrations; I did not find a clause on AI agents in the Onramp docs *(CDP terms not reviewed clause by clause: unverified)*. Laso: built for agents | **Privacy.com: forbids "automated purchasing software programs" (General Terms §4)**, while marketing agent use. Lithic/Stripe: no agent clause found |
| Per-card controls | Depend on the USDC-accepting issuer. Laso: fixed-amount, non-reloadable, US merchants only, 6-month expiry, **no merchant lock, no freeze documented**, card details returned to the caller | Privacy: `SINGLE_USE`, `MERCHANT_LOCKED`, `spend_limit` per `TRANSACTION`/`MONTHLY`/`ANNUALLY`/`FOREVER`, `PAUSED`/`CLOSED`, settable `exp_month`/`exp_year` (Cards docs). Lithic: single-use, spend limits, pause (adapter in this repo) |
| Spending cap a compromised host can't raise | **Yes**: on-chain SpendPermission allowance per day, revocable from another device | No: whoever holds the issuer API key can create cards up to the provider's own account limits |
| Owner experience | Top up the wallet ahead of time (`paygent topup`), approve a spend permission in their wallet, keep a little ETH for gas (or sponsor) | Link a bank or debit card in the issuer's app; paste a sandbox API key into `paygent setup` |
| Sandbox available to an individual now | On-ramp: Coinbase trial mode/sandbox (after CDP sign-up), MoonPay test keys, Stripe only after approval. USDC-accepting issuer: **none found** | Lithic sandbox: self-serve. Privacy sandbox: not documented in current docs *(unverified)* |
| Verdict for MVP | Supported (mock on-ramp + Base Sepolia), not recommended as the default | **Recommended default** |

## 3. Providers checked

### Direct fiat card issuers (path b)

| | Privacy.com | Lithic | Stripe Issuing |
|---|---|---|---|
| Who it serves | Consumers and small businesses (pricing page: Personal, Plus, Pro, Premium "Best for Small Businesses") | Companies running card programs | Platforms and businesses |
| API access | Paid plan required: "You must be subscribed to a paid Privacy Plan in order to access the Privacy API" (MCP docs) | Sandbox at sign-up: "Your account starts in Sandbox mode"; production: "contact Sales" | Sandbox instant; live after eligibility review |
| Funding | `CARD_DEBIT`, `DEPOSITORY_CHECKING` (Funding Sources docs) | Program funding account | Stripe balance |
| Terms on this use | **Forbidden as written** (§4) | No agent clause found; business program | Business purpose only: "cards must be used for business purposes" |
| Card controls | Best in class (§2) | Single-use, spend limits, pause | Spending controls |
| In this repo | No adapter (terms) | `lithic-sandbox` adapter, sandbox host only | None |

### On-ramps (path a)

| | Coinbase Onramp | Stripe crypto onramp | MoonPay |
|---|---|---|---|
| Integration access | CDP account + Secret API key; "New integrations start in trial mode"; application for full access | "To access the Stripe onramp, including in sandboxes, you must ... submit your onramp application"; reviewed "within 48 hours" | Test keys at sign-up; production keys after "KYB and product" approval |
| End-user KYC | Coinbase account KYC, or guest checkout for US residents "up to $500/week" | Stripe does KYC; Stripe is merchant of record | Tiered by volume *(aggregator)* |
| Status notes | Coinbase-hosted guest checkout "will be deprecated on June 30, 2026", replaced by the Headless Onramp API (US only) | Public preview | n/a |
| Session security | Single-use session tokens from your backend, 5-minute expiry | Onramp sessions created server-side | Signed widget URLs *(secondary source)* |
| Delivers USDC on Base | Yes ("Base" listed; "all crypto assets and networks available on Coinbase") | Not confirmed on the page read | Not checked |
| In this repo | Not shipped: the Onramp sandbox needs a **production** CDP API key ("Use your production CDP API key for the Headless Onramp API"; sandbox orders use a `sandbox-` `partnerUserRef` prefix), which conflicts with the no-live-credentials rule | Not shipped: application required even for sandbox | Not shipped |

Practical note: a self-hoster doesn't need any on-ramp integration to use path (a). They can buy USDC in their own Coinbase account and withdraw it to their own wallet. Paygent's on-ramp adapter only makes that a one-command top-up.

### USDC-accepting card issuers (needed for paths a and c)

| | Laso Finance | Crossmint / AgentCard / network agent tokens |
|---|---|---|
| Model | Prepaid US card bought with USDC on Base or Solana via x402 | Network-tokenized agent credentials (Visa Intelligent Commerce, Mastercard Agent Pay) |
| Individual access | Appears yes *(vendor docs)* | Mostly via platforms *(unverified)* |
| KYC | "Neither `/get-card` nor `/order-intl-card` reads an identity-verification status" | Varies |
| Controls | Fixed amount $5–$1,000, non-reloadable, US merchants only, 6-month expiry, forfeiture | Agent- and policy-scoped tokens |
| Card details | Returned to the caller | Merchant may never see a raw PAN |
| Sandbox | None published | Varies |
| In this repo | Not shipped (no sandbox; identity-check model is a counsel question) | Not shipped; long-term direction |

## 4. Terms that forbid this use

**Privacy.com.** Quoted from privacy.com/terms (General Terms, "Last updated: September 6, 2023"), Section 4, Restrictions:
> "use the Service in conjunction with automated purchasing software programs"
> "robot, spider, scraper, or other automated means"

Quoted from privacy.com/card-terms (Payment Terms):
> "Virtual Cards are not issued to you and are not for consumer use."
> "Payment Services may only be used for business purposes in the fifty states"

Paygent is automated purchasing software by any reading. Privacy.com's own agent page ("Unleash your AI agents securely with Privacy", mcp.privacy.com) suggests the company intends agent use, but the page links to no agent-specific terms, and it doesn't mention third-party or self-hosted MCP servers. Until Privacy.com confirms otherwise in writing, treat agent use as **not permitted**. That's why this repo ships no Privacy.com adapter.

**Stripe Issuing.** "Cards must be used for business purposes", and spend must be funded by a business. Consumer personal spend is out of scope.

**Next-best option.** If Privacy.com won't confirm:
1. **Owners with a sole proprietorship** can use a business issuing program (Lithic or Stripe) for genuine business purchases. That's a narrower audience than "US consumers", and the program operator takes on KYC obligations.
2. **Path (a)** becomes viable only when a USDC-accepting issuer offers a sandbox, identity checks, merchant lock, and freeze. Until then the crypto paths stay test-mode only.
3. **Network agent tokens** (Visa Intelligent Commerce / Mastercard Agent Pay) through a consumer-facing issuer are the long-term answer, and the adapter interface is built so one can be added without changing the core.

## 5. What the crypto path is still needed for

Even with direct fiat as the default, the wallet paths stay in the design because they provide things fiat can't:
1. **A cap outside the host.** The SpendPermission allowance is enforced by a contract. A fully compromised Paygent install can spend at most the daily allowance until the owner revokes it from another device. On path (b) the issuer API key is the whole spending authority, bounded only by provider account settings.
2. **Revocation without trusting the host.** The owner can call `revoke` from their wallet on their phone.
3. **Machine payments without cards.** x402 merchants can be paid directly from the allowance, with no card at all (planned).
4. **Owners who already hold stablecoins** and don't want to off-ramp.
5. **Owners without a US bank account,** later.

## 6. Spend-authority standards (wallet paths)

| | Coinbase Spend Permissions | ERC-7715 / ERC-7710 | Safe Allowance Module | Coinbase Agentic Wallets (MPC) |
|---|---|---|---|---|
| Status | Production; SpendPermissionManager `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` on Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche; testnets Base Sepolia and Ethereum Sepolia (CDP docs) | Draft ERCs with production implementations *(secondary)* | Production | Launched 2026-02-11 *(secondary)* |
| Enforcement | On-chain | On-chain (wallet-dependent) | On-chain | Provider's MPC policy layer |
| Spender-side revoke | `revokeAsSpender` (verified in contract source) | Varies | No | n/a |
| Choice | **Used** | Adapter later | Adapter later | Not chosen |

## 7. Agent payment protocols (context)

- **MCP.** The current spec revision is 2026-07-28. The pinned TypeScript SDK (1.32.2) negotiates up to 2025-11-25. Paygent uses stdio and loopback HTTP with a bearer token; remote OAuth is later work.
- **x402** *(secondary sources)*: v2 Dec 2025, x402 Foundation under the Linux Foundation from April 2026. Laso uses it.
- **AP2** (Google, Sept 2025): signed mandates. Approval records could align with AP2 later.
- **Visa Intelligent Commerce / Mastercard Agent Pay**: agent-scoped network tokens.

## 8. Could not verify

- Privacy.com: whether written permission for third-party agent use is available; sandbox URL; API key scoping; bank/debit funding fees.
- Lithic: whether individuals without an entity are accepted in sandbox. (Auth header verified: raw key in `Authorization`; `Idempotency-Key` UUID supported on `POST /v1/cards`.)
- Coinbase CDP terms on AI-agent use (clause-level review not done); entity requirements for Onramp full access; whether guest checkout deprecation took effect on 2026-06-30.
- On-ramp end-user fees (Coinbase's help-page estimate and aggregator figures disagree).
- Laso: issuing bank, network, state restrictions, compliance basis for orders without identity checks.
- Verified on-chain 2026-11-17: SpendPermissionManager has code on Base Sepolia, and `0x036CbD53842c5426634e7929541eC2318f3dCF7e` is `USDC` with 6 decimals; Paygent's ABI decodes against the deployed contract (`PAYGENT_NETWORK_TESTS=1 npm test`). Not verified: a full approve → spend → revoke cycle, which needs a Coinbase Smart Wallet and testnet funds.

## Sources

Primary (provider docs and terms):
- Privacy.com General Terms: https://privacy.com/terms; Payment/card terms: https://www.privacy.com/card-terms; pricing: https://privacy.com/pricing; agents page: https://agents.privacy.com
- Privacy.com developer docs: https://developers.privacy.com/docs (getting-started, mcp-server, cards, funding-sources)
- Lithic sign-up: https://docs.lithic.com/docs/sign-up
- Stripe Issuing use cases: https://support.stripe.com/questions/supported-business-use-cases-for-stripe-issuing; onboarding: https://docs.stripe.com/issuing/onboarding-overview
- Stripe crypto onramp: https://docs.stripe.com/crypto/onramp
- Lithic API basics: https://docs.lithic.com/docs/api-basics; idempotency: https://docs.lithic.com/docs/idempotent-requests
- Coinbase Onramp sandbox: https://docs.cdp.coinbase.com/onramp-&-offramp/integration/sandbox-testing; Onramp: https://docs.cdp.coinbase.com/onramp/docs/welcome; Coinbase-hosted Onramp: https://docs.cdp.coinbase.com/onramp/coinbase-hosted-onramp/overview; session tokens: https://docs.cdp.coinbase.com/api-reference/rest-api/onramp-offramp/create-session-token; consumer fees: https://help.coinbase.com/en-gb/wallet/managing-account/buy-crypto
- MoonPay partner onboarding: https://support.moonpay.com/en/articles/694185-partner-onboarding-overview-from-signup-to-going-live; launch guide: https://dev.moonpay.com/v1.0/docs/production-build
- Coinbase Spend Permissions: https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions; contract: https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol
- Laso Finance: https://docs.laso.finance/guides/usa-prepaid-card
- MCP 2026-07-28 authorization: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

Secondary *(unverified)*:
- https://eco.com/support/en/articles/15210390-best-stablecoin-onramps-2026-moonpay-transak-coinbase-onramp-compared
- https://stablecoininsider.org/stablecoin-on-off-ramps/
- https://www.crossmint.com/learn/agent-card-payments-compared
- https://atxp.ai/blog/agent-payment-protocols-compared
- https://eco.com/support/en/articles/15254038-erc-7715-session-keys-2026-granular-permissions-explained
- https://www.cloaked.com/post/privacy-com-alternatives
