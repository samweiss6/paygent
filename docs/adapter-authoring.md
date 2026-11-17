# Writing a Paygent adapter

An adapter connects Paygent to one provider: a **card issuer** or a **fiat on-ramp**. Adapters are deliberately small and deliberately powerless. They never see Paygent's keys, policy, ledger, audit log, or wallet, and the core double-checks what they return.

The types live in `src/adapters/types.ts`. A complete working example is in `examples/third-party-adapter/`.

## Which kind do you need?

| Kind | Implement | Used by funding path |
|---|---|---|
| `issuer` | `createCard`, `freezeCard`, `getCardStatus` (optionally `simulateCharge` for sandboxes) | All three. Declare which via `fundingModels` |
| `onramp` | `createTopUp`, `getTopUpStatus` (optionally `simulateComplete`) | `fiat_onramp` |

An issuer declares how its cards are funded:
- `"fiat_linked"`: the provider charges the owner's bank account or debit card linked in the owner's provider account. Works with `fiat_direct`.
- `"usdc_deposit"`: the provider accepts USDC at a deposit address. Works with `fiat_onramp` and `crypto_wallet`. The deposit address is set by the owner in signed config, not by your adapter.

Paygent refuses to start if the configured issuer doesn't support the configured path.

## Layout

```
my-adapter/
  paygent-adapter.json   manifest
  index.js               entry: export default function create(ctx) { ... }
```

Plain JavaScript (ESM) is easiest. TypeScript works too if it uses only erasable syntax and the entry is a `.ts` file.

### Manifest

```json
{
  "id": "acme-cards",
  "kind": "issuer",
  "displayName": "Acme Cards (sandbox)",
  "version": "0.1.0",
  "entry": "index.js",
  "allowedHosts": ["sandbox.api.acme.example"],
  "fundingModels": ["fiat_linked"],
  "capabilities": { "singleUse": true, "merchantLock": "first_use", "perCardCap": true, "expiry": true, "freeze": true },
  "testModeOnly": true
}
```

- `id`: lowercase letters, digits, hyphens. The owner stores your API key as `<id>.api_key` with `paygent secrets set`.
- `allowedHosts`: every host you call. The owner sees this list when installing. Use the provider's **sandbox** host only.
- `testModeOnly` must be `true` in v0.1.

### The context you get

```js
export default function create(ctx) {
  ctx.apiKey    // your provider API key, or null
  ctx.config    // non-secret settings from the owner's config
  ctx.http      // fetch(), restricted to https + allowedHosts, redirects refused
  ctx.log       // .info(msg, data) / .warn(msg, data); output is redacted
  ctx.testMode  // always true in v0.1
  return { manifest, createCard, freezeCard, getCardStatus };
}
```

Use `ctx.http`, not global `fetch` or `node:https`. Third-party adapters run in a separate Node process with the permission model on: you can read only your own directory, you can't write files, start processes, or read environment variables. Node doesn't sandbox raw network access, so owners are told to review adapters, and calls outside `ctx.http` are treated as a red flag in review.

## Issuer contract

### `createCard(req) → IssuedCard`

`req`: `{ amountCents, merchant, expiresAt, idempotencyKey, memo }`

- Create a card that can be charged **once**, for **at most `amountCents`**, and not after `expiresAt`. If your provider can lock to the first merchant, do it.
- Pass `idempotencyKey` to the provider if it supports idempotency.
- Return:

```js
{
  providerCardId: "card_123",
  pan: "4000…", cvv: "123", expMonth: "07", expYear: "2028", last4: "…",
  controls: { singleUse: true, capCents: 525, expiresAt: "2026-11-17T13:00:00Z" }
}
```

`controls` must describe what the **provider actually set**, read back from its response, not what you asked for. The core rejects and freezes the card if `singleUse` is false, `capCents` is missing or above the request, or `last4` doesn't match the PAN.

Don't log, cache, or return the PAN anywhere else. The core moves it into an encrypted vault immediately.

### `freezeCard(providerCardId)`

Stop the card from authorizing. It must be idempotent. It's called on cancel, on expiry, on the kill switch, and when controls don't match.

### `getCardStatus(providerCardId) → { state, transactions }`

`state`: `open | frozen | closed | used`. `transactions`: `{ amountCents, merchantDescriptor, status: pending | settled | declined }[]`. Paygent marks a payment settled when it sees a settled transaction.

## On-ramp contract

### `createTopUp(req) → { providerSessionId, hostedUrl, expiresAt }`

`req`: `{ amountCents, destinationAddress, asset, idempotencyKey }`

Create a session on the provider that, once the owner completes it in their browser, delivers `asset` (e.g. `USDC:base-sepolia`) to `destinationAddress`. The destination is the owner's own wallet from signed config; never substitute another address. `hostedUrl` must be the provider's own domain. KYC and payment details stay between the owner and the provider. Your adapter must not collect them.

### `getTopUpStatus(id) → { state, deliveredUnits, txHash }`

`state`: `created | pending | completed | failed | expired`.

## Errors

Throw `Error` with a short message. Don't include response bodies, since they can echo request fields. Never include keys or card data. The core logs the message, and the agent sees only a generic error.

## Testing

- Write tests against recorded sandbox responses with a fake `fetch` passed to `buildContext` (see the Lithic test in `test/adapters.test.ts`).
- Run your adapter through the sandbox host: `startSandboxedAdapter({ adapterDir, config, apiKey })` in a test, exactly as Paygent will.
- Install locally: `paygent setup --issuer /path/to/my-adapter`.

## Getting an adapter built in

Built-in adapters must target a provider with a public sandbox **and** terms that allow owner-configured automated or AI-agent purchasing. Include links to both in your pull request. Adapters for providers whose terms are unclear can still be published as third-party adapters.
