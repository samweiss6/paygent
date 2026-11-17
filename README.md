# Paygent

Paygent is a self-hosted MCP server that lets your AI agent pay for things with single-use virtual cards, inside spending limits you set. It runs on your machine, uses your own provider accounts, and never shows card numbers to the agent.

> **Status: v0.1, test mode only.** No real money moves. Paygent v0.1 talks only to built-in mocks, provider sandboxes, and the Base Sepolia testnet. Read [Status and disclaimer](#status-and-disclaimer) before using it for anything else.

## How it works

1. Your agent calls `request_payment` with a merchant, an exact amount, and a description.
2. Paygent checks your policy: per-payment, daily, and monthly limits, merchant allow and deny lists, and approval rules. New merchants and anything over $10 wait for your approval by default.
3. Paygent funds the payment from the source you chose:
   - **`fiat_direct`** (default): your bank account or debit card, linked in your card issuer's account. No crypto.
   - **`fiat_onramp`**: you top up your own wallet with USDC from your bank or debit card through an on-ramp. Payments draw on an on-chain allowance you can revoke.
   - **`crypto_wallet`**: USDC you already hold in your own smart wallet, through the same revocable allowance.
4. Your issuer creates a single-use card capped at the amount (plus a small tolerance) that expires within an hour.
5. Paygent types the card into the merchant's checkout page in the agent's browser (`checkout_fill`), or you see it with `paygent reveal`. Either way the agent never receives the number.

## Five-minute setup

Requires Node.js 24 or later.

```sh
git clone https://github.com/samweiss6/paygent && cd paygent
npm ci --ignore-scripts
node bin/paygent.js setup          # choose fiat_direct + mock to try it with no accounts
node bin/paygent.js start          # leave running; MCP on http://127.0.0.1:7402/mcp
```

Setup asks for two passphrases, and they must differ. The **daemon passphrase** unlocks Paygent's own keys when it starts. The **owner passphrase** is needed only to approve payments and change policy. Because they're separate, the running daemon can't approve its own payments.

Add Paygent to your agent. Most MCP clients (Claude Code, Claude Desktop, Cursor and others) accept this:

```json
{
  "mcpServers": {
    "paygent": {
      "command": "node",
      "args": ["/absolute/path/to/paygent/bin/paygent.js", "mcp"]
    }
  }
}
```

For Claude Code: `claude mcp add paygent -- node /absolute/path/to/paygent/bin/paygent.js mcp`

Clients that speak HTTP can connect to `http://127.0.0.1:7402/mcp` directly with the header `Authorization: Bearer <contents of ~/.paygent/mcp-token>`.

Then ask your agent to buy something. When it requests a payment from a new merchant:

```sh
node bin/paygent.js pending        # see what's waiting
node bin/paygent.js approve pay_…  # asks for your owner passphrase
```

### With Docker

```sh
mkdir -p secrets && printf '%s' 'your daemon passphrase' > secrets/daemon_passphrase.txt && chmod 600 secrets/daemon_passphrase.txt
docker compose run --rm paygent setup
docker compose up -d
docker compose exec paygent paygent pending
```

The container runs as a non-root user with a read-only filesystem and no Linux capabilities, and publishes port 7402 on `127.0.0.1` only. (The Docker image hasn't been built in testing yet; the Node.js path is the tested one.)

## Agent tools

| Tool | What it does |
|---|---|
| `get_balance` | Remaining daily and monthly spend under your policy, plus the funding source's status |
| `list_policies` | Read-only view of your policy |
| `request_payment` | Ask to pay a merchant. Returns `issued`, `pending_approval`, or `denied` |
| `get_payment_status` | Status, card last 4 digits, cap, expiry |
| `checkout_fill` | Paygent fills the card form in the agent's Chromium browser over the DevTools Protocol, only on the merchant's own https page or inside an allowed payment iframe (Stripe, Braintree, Shopify) on that page |
| `cancel_payment` | Cancel and freeze the card |

There is no tool to change policy, approve payments, top up, or read card numbers. `reveal_card_to_agent` exists only if you turn on `cards.allow_reveal_to_agent`, which we don't recommend.

## Owner commands

```
paygent status | pending | doctor
paygent approve <id> | reject <id>
paygent reveal <id>                 show a card to you, in your terminal
paygent topup <usd>                 fiat_onramp: start a top-up on the provider's page
paygent kill                        freeze everything now (see below)
paygent unfreeze
paygent policy show | policy set limits.daily_usd '"40.00"'
paygent secrets set lithic-sandbox.api_key
paygent audit verify | head | tail
```

**Kill switch.** `paygent kill` stops new payments immediately, revokes the on-chain allowance (wallet paths), freezes every open card, cancels pending requests, and returns any spender balance to your wallet. On `fiat_direct`, also rotate your issuer API key in the provider's dashboard. On wallet paths you can always revoke from your own wallet on another device, without Paygent.

## Choosing a funding path

| | `fiat_direct` | `fiat_onramp` | `crypto_wallet` |
|---|---|---|---|
| You need | A card-issuer account with a linked bank or debit card | An on-ramp account and a smart wallet | A smart wallet with USDC |
| Crypto knowledge | None | A little | Yes |
| Limit outside your computer | Only what your issuer's account settings allow | On-chain daily allowance | On-chain daily allowance |
| Revoke from another device | Rotate the key in the issuer's dashboard | Yes, from your wallet | Yes, from your wallet |

`fiat_direct` is the simplest. The wallet paths add a hard daily cap that even a compromised computer can't raise. If you use `fiat_direct`, set account-level limits in your issuer's own app as well.

**Provider status.** Built in: `mock` (issuer), `lithic-sandbox` (issuer, sandbox only), `mock-onramp`. Privacy.com's current terms prohibit "automated purchasing software", so there's no Privacy.com adapter. See [docs/03-provider-comparison.md](docs/03-provider-comparison.md) for the details and for what's needed before any live provider can be supported.

## Security model in brief

- Card numbers never enter the agent's context, Paygent's logs, or MCP responses by default.
- Your policy is signed with your owner key. If the file is edited, Paygent stops approving payments.
- The MCP server listens on `127.0.0.1` only and requires a bearer token. Remote exposure is off and needs explicit TLS setup; see [SECURITY.md](SECURITY.md).
- Every request, decision, and payment goes in a hash-chained audit log (`paygent audit verify`).
- Third-party adapters run in a separate process that can't read your keys or files, and can reach only the hosts they declared.

Full details: [docs/01-architecture.md](docs/01-architecture.md) and [docs/02-threat-model-and-policy.md](docs/02-threat-model-and-policy.md).

## Development

```sh
npm ci --ignore-scripts
npm test          # node:test; no network, no accounts
npm run typecheck
PAYGENT_NETWORK_TESTS=1 npm test   # also reads the real contract on Base Sepolia (no keys, read-only)
```

Writing an adapter for another issuer or on-ramp: [docs/adapter-authoring.md](docs/adapter-authoring.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## Status and disclaimer

Paygent is software you run yourself. It is not a bank, a money transmitter, or a financial service, and its authors don't hold, move, or have access to your money. v0.1 works only in test mode, and nothing in it is approved for real purchases. If you connect it to live provider accounts in a future version, you're responsible for complying with those providers' terms, which may restrict automated or AI-agent use, and with the laws where you live. Agent purchases may not be disputable the way purchases you make yourself are. This wording is a draft awaiting legal review; see [docs/04-legal-questions-for-counsel.md](docs/04-legal-questions-for-counsel.md).

Licensed under the [Apache License 2.0](LICENSE).
