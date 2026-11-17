# Provider comparison and MVP recommendation

Researched 2026-11-17. Not legal advice. Where a fact comes from a vendor's own marketing or a third-party blog rather than primary docs or terms, it's marked *(unverified)*. Re-check everything here before any live use.

## 1. Summary

- **There is no provider today that cleanly fits "US consumer, crypto-funded, AI agent buys things, self-serve API, terms that allow it."** Each candidate fails at least one of those.
- **Privacy.com's terms conflict with this use.** Its General Terms prohibit using the service "in conjunction with automated purchasing software programs", say "Virtual Cards are not issued to you and are not for consumer use", and limit Payment Services to "business purposes". Privacy.com also ships an official MCP server for AI agents, so its terms and its product point in opposite directions. Until Privacy.com confirms in writing that agent use through a third-party MCP server is allowed, Paygent should not offer a live Privacy.com adapter.
- **Stripe Issuing and Lithic are business programs.** Stripe requires business-purpose spend funded by a business (sole proprietors allowed). Lithic's live mode requires contacting sales and setting up a program. Both have self-serve sandboxes, which makes them useful for building and testing, but they aren't paths for consumers.
- **Laso Finance is the closest crypto-native fit** (USDC on Base → US prepaid card, over x402, built for agents), but it returns raw card details to the caller, publishes no sandbox, and its order endpoints don't check identity. Paygent can contain the first problem, but the last two are open questions for the owner and counsel.
- **Recommendation for the MVP:** ship the core against the built-in `mock` issuer and a **Lithic sandbox** adapter (self-serve sandbox, granular per-card controls, an API designed for programmatic issuing), with **Laso** planned but not shipped in v0.1. Authority: **Coinbase Spend Permissions on Base Sepolia**. No live mode in v0.1.

## 2. Card issuers

| | Privacy.com (API) | Lithic | Stripe Issuing | Laso Finance | Crossmint / AgentCard / VIC-based agent cards |
|---|---|---|---|---|---|
| Model | Consumer-facing fintech issuing virtual cards from a linked bank | Card-issuing platform (BaaS) for companies running programs | Card issuing for platforms and businesses | Prepaid cards bought with USDC via x402 | Network-tokenized agent credentials |
| Individual can open an account without a business entity | Yes for sign-up; but terms say Payment Services are for **business purposes** and cards "not for consumer use" | Sandbox self-serve; live requires sales and a program *(entity requirements not stated in docs)* | Sandbox instant; live requires an eligibility review, business-purpose spend funded by a business (sole proprietor OK) | Appears yes; no business entity mentioned *(unverified)* | Mostly sold to platforms *(unverified)* |
| US availability | 50 states + DC | Program-dependent | Program-dependent | US merchants only; state list not published | Varies |
| KYC burden on the user | Privacy CIP before transacting | Program operator does KYC on cardholders | Platform does KYC on connected accounts | Order endpoints don't check identity status (per its docs) | Varies |
| Funding | Linked bank account (ACH) | Program funding account | Stripe balance | USDC on Base or Solana | Underlying card or stablecoin |
| Programmatic card creation | Yes (`POST /v1/cards`), paid plan required for API | Yes | Yes | Yes (`/get-card?amount=`) | Yes |
| Single-use | `SINGLE_USE` | Yes | Configurable via spending controls | Non-reloadable, multi-use until balance spent | Yes (scoped tokens) |
| Merchant lock | `MERCHANT_LOCKED` (first merchant) | Yes (auth rules) | Allowed/blocked categories and merchants via spending controls | No (US merchants only) | Yes |
| Per-card cap | `spend_limit` + duration | Yes | Yes | Card value = amount loaded ($5–$1,000) | Yes |
| Expiry control | `exp_month`/`exp_year` | Yes | Yes | Fixed 6 months; remaining balance forfeited | Varies |
| Freeze/close | `PAUSED`/`CLOSED` | Yes | Yes | Not documented | Varies |
| PAN delivery | Returned in API response; MCP server has `get_pan` tool that returns PAN/CVV to the agent | API; hosted/embedded display options *(unverified)* | API with ephemeral keys / Issuing Elements | Returned to the caller (`card_number`, `cvv`) | Tokenized: the merchant may never see a PAN |
| Fees | Paid plan required for API *(price not checked)* | Per-program *(not published)* | Per-card fees *(not checked)* | "No fee: the amount you pay is the amount on the card" (vendor claim) | Not published |
| Terms on automated/agent use | **Prohibits "automated purchasing software programs" and "robot, spider, scraper, or other automated means"**, while shipping an agent MCP server | Not found in public docs | Business purposes only; no agent-specific clause found | Built for agents | Built for agents |
| Sandbox | Not documented in current docs *(historically `sandbox.privacy.com`, unverified)* | Yes (`sandbox.lithic.com`) | Yes | **None published** | Varies |

## 3. On-ramps and off-ramps (USD ↔ USDC)

The owner funds their own wallet, so Paygent doesn't integrate an on-ramp in v0.1. It documents the options, and the setup wizard links to them.

| | Coinbase (Onramp / exchange account) | MoonPay | Bridge (Stripe) |
|---|---|---|---|
| Individual US customer | Yes | Yes, "50 US states" *(aggregator claim)* | Mainly business/platform *(unverified)* |
| Fees | ~0.5% ACH, ~2.5% card for Onramp *(aggregator)*; USDC↔USD conversion reported free on Coinbase, though sources disagree | Up to 4.5% card *(aggregator)* | Not found |
| KYC | Standard exchange KYC | Tiered by lifetime volume: <$2k basic ID, $2k–$10k + address, >$10k + source of funds *(aggregator)* | KYB/KYC via platform |
| Programmatic for an individual | Owner's own Coinbase account; Onramp is a widget | Widget | API for businesses |
| Notes | Also the source of Spend Permissions; Base Sepolia faucet for USDC test funds via CDP | Broad coverage | Natural fit if a future issuer is Stripe-based |

## 4. Spend-authority standards

| | Coinbase Spend Permissions | ERC-7715 / ERC-7710 | Safe Allowance Module | Coinbase Agentic Wallets (MPC) |
|---|---|---|---|---|
| Status | Production; SpendPermissionManager `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` on Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche, and Base/Ethereum Sepolia (CDP docs) | Draft ERCs with production implementations *(secondary sources)* | Production | Launched 2026-02-11 *(secondary source)* |
| Enforcement | On-chain contract | On-chain (wallet-dependent) | On-chain | Provider's MPC policy layer |
| Period limits | Yes | Yes | Yes | Yes |
| Spender-side revoke | `revokeAsSpender` (verified in contract source) | Varies | No | n/a |
| Non-custodial | Yes | Yes | Yes | Provider holds a key share |
| Choice | **MVP** | Adapter later | Adapter later | Not chosen |

## 5. Agent payment protocols (context)

- **MCP 2026-07-28** is the current spec revision. Authorization is optional for local servers; remote servers use OAuth with Client ID Metadata Documents. Paygent v0.1 uses stdio and loopback HTTP with a bearer token, and remote OAuth is listed as later work.
- **x402** (HTTP 402 stablecoin payments; v2 Dec 2025; moved to an x402 Foundation under the Linux Foundation in April 2026 *(secondary sources)*). Laso uses it. A future Paygent tool could pay x402 merchants directly from the allowance, with no card at all.
- **AP2** (Google, Sept 2025): signed "mandates" proving user intent; x402 extension. Worth aligning approval records with AP2 mandates later.
- **Visa Intelligent Commerce / Mastercard Agent Pay**: network-tokenized, agent-scoped credentials. This is the long-term answer to "PAN never in the agent's reach", but access runs through issuers and platforms, not individuals.

## 6. Recommendation

**MVP (this repo):**
1. Authority: Coinbase Spend Permissions on Base Sepolia, plus an in-process `mock` authority that implements the same per-period semantics for tests and dry runs.
2. Issuer: `mock` (default) and `lithic-sandbox` (tested against recorded responses; works against the real Lithic sandbox with the owner's sandbox key).
3. Laso: not shipped in v0.1. It needs the core to sign x402 payments (adapters never get keys), it has no sandbox to test against safely, and its identity-check model is an open question. Planned as a core-signed x402 funding path once those are resolved.
4. Privacy.com: **no adapter** until its terms question is resolved in writing.

**Before any live release:** get written confirmation from at least one issuer that (a) an individual may hold the account, (b) cards may be created and used through owner-configured automation, including AI agents, and (c) funding from the owner's own crypto off-ramp is acceptable. Without that, live mode stays unbuilt.

## 7. Could not verify

- Lithic sandbox: whether individuals without an entity are accepted; exact auth header format (adapter uses `Authorization: <api-key>`, confirm against Lithic docs).
- Privacy.com: current sandbox URL; API plan pricing.
- Laso: issuing bank, card network, state restrictions, compliance basis for no-KYC orders.
- Fees for all on-ramps (aggregator figures only, and sources disagree).
- Status of Coinbase's pivot from session keys to Sub Accounts.

## Sources

- Coinbase CDP, Spend Permissions: https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions
- SpendPermissionManager source: https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol
- Base tutorial, spend permissions: https://docs.base.org/tutorials/create-subscription-payments-with-spend-permissions
- Privacy.com developer docs: https://developers.privacy.com/docs, MCP server: https://developers.privacy.com/docs/mcp-server.md, Cards: https://developers.privacy.com/docs/cards.md
- Privacy.com terms: https://www.privacy.com/card-terms, https://privacy.com/terms
- Lithic sign-up: https://docs.lithic.com/docs/sign-up; Lithic terms: https://lithic.com/legal
- Stripe Issuing use cases: https://support.stripe.com/questions/supported-business-use-cases-for-stripe-issuing; onboarding: https://docs.stripe.com/issuing/onboarding-overview
- Laso Finance prepaid card guide: https://docs.laso.finance/guides/usa-prepaid-card
- MCP 2026-07-28 authorization: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization; release post: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- On/off-ramp comparisons (secondary): https://eco.com/support/en/articles/15210390-best-stablecoin-onramps-2026-moonpay-transak-coinbase-onramp-compared, https://stablecoininsider.org/stablecoin-on-off-ramps/
- Agent card landscape (secondary): https://www.crossmint.com/learn/agent-card-payments-compared, https://nevermined.ai/blog/ai-agent-card-delegation
- x402 / AP2 (secondary): https://atxp.ai/blog/agent-payment-protocols-compared, https://techcrunch.com/2025/09/16/google-launches-new-protocol-for-agent-driven-purchases/
- ERC-7715 (secondary): https://eco.com/support/en/articles/15254038-erc-7715-session-keys-2026-granular-permissions-explained
