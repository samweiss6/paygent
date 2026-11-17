// Opt-in: reads the real SpendPermissionManager on Base Sepolia. No keys, no funds, read-only.
// Run with: PAYGENT_NETWORK_TESTS=1 npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http, erc20Abi } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SpendPermissionAuthority, SPEND_PERMISSION_MANAGER, BASE_SEPOLIA_USDC, proposePermission } from "../src/authority/spend-permission.ts";

const RPC = process.env.PAYGENT_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const run = process.env.PAYGENT_NETWORK_TESTS === "1";

test("Base Sepolia: contract deployed, USDC address correct, ABI matches", { skip: !run && "set PAYGENT_NETWORK_TESTS=1", timeout: 30_000 }, async () => {
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const code = await pub.getCode({ address: SPEND_PERMISSION_MANAGER });
  assert.ok(code && code.length > 1000, "SpendPermissionManager has code");
  assert.equal(await pub.readContract({ address: BASE_SEPOLIA_USDC, abi: erc20Abi, functionName: "symbol" }), "USDC");
  assert.equal(await pub.readContract({ address: BASE_SEPOLIA_USDC, abi: erc20Abi, functionName: "decimals" }), 6);

  // A fresh, never-approved permission: every view call must decode, and it must report no headroom.
  const spenderKey = generatePrivateKey();
  const owner = privateKeyToAccount(generatePrivateKey()).address;
  const permission = proposePermission({ account: owner, spender: privateKeyToAccount(spenderKey).address, dailyAllowanceUnits: 50_000_000n, durationDays: 30 });
  const auth = new SpendPermissionAuthority({ permission, spenderPrivateKey: spenderKey, rpcUrl: RPC });
  const info = await auth.info();
  assert.equal(info.revoked, false);
  assert.equal(info.remainingUnits, 0n, "unapproved permission has no headroom");
  assert.equal(info.allowanceUnits, 50_000_000n);
  assert.equal(info.ownerBalanceUnits, 0n);
  await assert.rejects(auth.spend(1n), /not approved on-chain and no owner signature/);
});
