# Security policy

Paygent handles money and card credentials, so we take reports seriously and would rather hear about a possible issue than miss one.

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting: on this repository, open **Security → Report a vulnerability**. If that isn't available to you, open a public issue that says only "requesting a security contact", with no details, and a maintainer will reply with a private channel.

Please include what you found, how to reproduce it, and what an attacker could do with it. Proof-of-concept code is welcome. Please test only against your own install in test mode: never use real cards, live provider keys, or other people's systems.

What to expect:
- Acknowledgement within 3 business days.
- An assessment and planned fix timeline within 10 business days.
- Credit in the release notes if you'd like it.
- We aim to release a fix within 90 days and coordinate disclosure timing with you.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes (test mode only) |

## Scope

In scope: anything that lets an agent, a web page, an adapter, a dependency, or another local user:
- spend beyond the owner's policy or on-chain allowance;
- obtain card numbers, keys, or passphrases;
- approve payments, change policy, or unfreeze without the owner key;
- tamper with the audit log without detection;
- reach the MCP server or control socket without authorization.

Out of scope: attacks that require root on the host, or the owner's passphrases (these are documented residual risks); provider-side vulnerabilities, which should be reported to the provider; social engineering of the owner.

## Remote exposure

By default the MCP server listens only on `127.0.0.1` and requires a bearer token. Exposing it to a network means anyone who obtains the token can request payments within your policy. If you do it anyway:
1. Set `remote.enabled: true` with `paygent policy set` (needs your owner passphrase).
2. Configure `mcp.tls_cert` and `mcp.tls_key`. Paygent refuses to bind to a non-loopback address without them.
3. Put it behind a firewall or VPN, and treat `~/.paygent/mcp-token` as a password.
4. Keep approval for new merchants on, and keep caps low.

The control socket (`~/.paygent/control.sock`) is never exposed to the network.

## Supply chain

- Runtime dependencies are pinned to exact versions, and the lockfile is committed. Install with `npm ci --ignore-scripts`.
- We don't take dependency updates in the first two weeks after a release.
- Releases will be signed: npm provenance for packages, Sigstore/cosign for container images, and signed git tags. **v0.1 is not yet signed.** Verify the commit hash against this repository.
- Third-party adapters are untrusted code and run in a sandboxed child process. Review an adapter before installing it: the sandbox doesn't restrict raw network access.
