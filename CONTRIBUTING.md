# Contributing to Paygent

Thanks for helping. Paygent moves money on behalf of people who often aren't security experts, so contributions are held to a few firm rules.

## Ground rules

1. **Test mode only.** Never commit real card numbers, live API keys, or mainnet configuration. Tests must run with no network access and no accounts.
2. **Keep the core small.** The core (`src/` outside `src/adapters/builtin/`) should stay reviewable by one person in an afternoon. New runtime dependencies need a strong reason, and we'll ask for one in review.
3. **Secure defaults.** A change that loosens a default (higher caps, fewer approvals, anything that exposes card data or a port) needs a threat-model update in `docs/02-threat-model-and-policy.md` in the same pull request.
4. **No card data in agent output.** Any new MCP tool must keep PANs, CVVs, keys, and passphrases out of its output and errors. `test/mcp-injection.test.ts` checks this; extend it for new tools.
5. **Policy is decided outside the agent.** The agent must never be able to change policy, approve, unfreeze, or top up. Don't add MCP tools that do.

## Setup

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

Node.js 24+. The source is TypeScript run directly with Node's type stripping, so there's no build step. That means no TypeScript-only runtime syntax (enums, namespaces, parameter properties).

## Pull requests

- One change per pull request, with tests. Bug fixes need a test that fails without the fix.
- Security-relevant changes (policy engine, service, keystore, audit, MCP surface, adapter host) need a review from a maintainer other than the author.
- Use plain commit messages that say what changed and why.
- By contributing you agree your work is licensed under Apache-2.0. Add a `Signed-off-by` line (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).

## Adapters

New issuers and on-ramps belong in adapters, not the core. See [docs/adapter-authoring.md](docs/adapter-authoring.md). We accept built-in adapters only for providers with a public sandbox and terms that permit this use. Others can be published as third-party adapters.

## Reporting security issues

Not in public issues. See [SECURITY.md](SECURITY.md).
