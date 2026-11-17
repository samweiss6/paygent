// Coinbase Spend Permissions on Base Sepolia (testnet only in v0.1).
// Contract: SpendPermissionManager 0xf85210B21cC50302F477BA56686d2019dC9b67Ad
// Source: https://github.com/coinbase/spend-permissions (src/SpendPermissionManager.sol)

import {
  createPublicClient, createWalletClient, http, parseAbi, erc20Abi, type Hex, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { AllowanceInfo, SpendAuthority } from "./types.ts";

export const SPEND_PERMISSION_MANAGER: Address = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad";
/** Circle's USDC on Base Sepolia. */
export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const SP_TUPLE = "(address account, address spender, address token, uint160 allowance, uint48 period, uint48 start, uint48 end, uint256 salt, bytes extraData)";
export const spendPermissionAbi = parseAbi([
  `function approveWithSignature(${SP_TUPLE} spendPermission, bytes signature) returns (bool)`,
  `function spend(${SP_TUPLE} spendPermission, uint160 value)`,
  `function revokeAsSpender(${SP_TUPLE} spendPermission)`,
  `function getCurrentPeriod(${SP_TUPLE} spendPermission) view returns ((uint48 start, uint48 end, uint160 spend))`,
  `function isApproved(${SP_TUPLE} spendPermission) view returns (bool)`,
  `function isRevoked(${SP_TUPLE} spendPermission) view returns (bool)`,
  `function isValid(${SP_TUPLE} spendPermission) view returns (bool)`,
]);

export interface SpendPermission {
  account: Address;
  spender: Address;
  token: Address;
  allowance: bigint;
  period: number;
  start: number;
  end: number;
  salt: bigint;
  extraData: Hex;
}

/** JSON form stored in config.json (bigints as decimal strings). */
export interface SpendPermissionJson {
  account: string; spender: string; token: string; allowance: string;
  period: number; start: number; end: number; salt: string; extraData: string;
  /** Optional owner signature from wallet_grantPermissions / signTypedData; used once via approveWithSignature. */
  signature?: string;
}

export function permissionFromJson(j: SpendPermissionJson): SpendPermission {
  return {
    account: j.account as Address, spender: j.spender as Address, token: j.token as Address,
    allowance: BigInt(j.allowance), period: j.period, start: j.start, end: j.end,
    salt: BigInt(j.salt), extraData: j.extraData as Hex,
  };
}

export class SpendPermissionAuthority implements SpendAuthority {
  readonly mode = "base-sepolia" as const;
  #perm: SpendPermission;
  #signature: Hex | undefined;
  #pub;
  #wallet;
  #account;

  constructor(opts: { permission: SpendPermissionJson; spenderPrivateKey: Hex; rpcUrl: string }) {
    this.#perm = permissionFromJson(opts.permission);
    this.#signature = opts.permission.signature as Hex | undefined;
    this.#account = privateKeyToAccount(opts.spenderPrivateKey);
    if (this.#account.address.toLowerCase() !== this.#perm.spender.toLowerCase()) {
      throw new Error("spender key does not match the permission's spender address");
    }
    if (this.#perm.token.toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()) {
      throw new Error("permission token must be Base Sepolia USDC in v0.1");
    }
    this.#pub = createPublicClient({ chain: baseSepolia, transport: http(opts.rpcUrl) });
    this.#wallet = createWalletClient({ chain: baseSepolia, transport: http(opts.rpcUrl), account: this.#account });
  }

  async #write(functionName: "spend" | "revokeAsSpender" | "approveWithSignature", args: readonly unknown[]) {
    const hash = await this.#wallet.writeContract({
      address: SPEND_PERMISSION_MANAGER, abi: spendPermissionAbi, functionName, args: args as never,
    });
    const receipt = await this.#pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }

  async #ensureApproved() {
    const approved = await this.#pub.readContract({ address: SPEND_PERMISSION_MANAGER, abi: spendPermissionAbi, functionName: "isApproved", args: [this.#perm] });
    if (approved) return;
    if (!this.#signature) throw new Error("spend permission is not approved on-chain and no owner signature is configured");
    await this.#write("approveWithSignature", [this.#perm, this.#signature]);
  }

  async info(): Promise<AllowanceInfo> {
    const [period, revoked, valid, ownerBal, spenderBal] = await Promise.all([
      this.#pub.readContract({ address: SPEND_PERMISSION_MANAGER, abi: spendPermissionAbi, functionName: "getCurrentPeriod", args: [this.#perm] }),
      this.#pub.readContract({ address: SPEND_PERMISSION_MANAGER, abi: spendPermissionAbi, functionName: "isRevoked", args: [this.#perm] }),
      this.#pub.readContract({ address: SPEND_PERMISSION_MANAGER, abi: spendPermissionAbi, functionName: "isValid", args: [this.#perm] }),
      this.#pub.readContract({ address: this.#perm.token, abi: erc20Abi, functionName: "balanceOf", args: [this.#perm.account] }),
      this.#pub.readContract({ address: this.#perm.token, abi: erc20Abi, functionName: "balanceOf", args: [this.#perm.spender] }),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const live = (valid || !!this.#signature) && !revoked && now < this.#perm.end && now >= this.#perm.start;
    return {
      mode: "base-sepolia",
      remainingUnits: live ? this.#perm.allowance - period.spend : 0n,
      allowanceUnits: this.#perm.allowance,
      periodEndsAt: new Date(Number(period.end) * 1000).toISOString(),
      permissionEndsAt: new Date(this.#perm.end * 1000).toISOString(),
      ownerBalanceUnits: ownerBal,
      spenderBalanceUnits: spenderBal,
      revoked,
    };
  }

  async spend(units: bigint) {
    await this.#ensureApproved();
    return { ref: await this.#write("spend", [this.#perm, units]) };
  }

  async forward(to: Address, units: bigint) {
    const hash = await this.#wallet.writeContract({ address: this.#perm.token, abi: erc20Abi, functionName: "transfer", args: [to, units] });
    const r = await this.#pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`USDC transfer reverted: ${hash}`);
    return { ref: hash };
  }

  async sweep() {
    const units = await this.#pub.readContract({ address: this.#perm.token, abi: erc20Abi, functionName: "balanceOf", args: [this.#perm.spender] });
    if (units === 0n) return { ref: null, units };
    const { ref } = await this.forward(this.#perm.account, units);
    return { ref, units };
  }

  async revoke() {
    return { ref: await this.#write("revokeAsSpender", [this.#perm]) };
  }
}

/** Build the permission struct the owner approves in their own wallet during setup. */
export function proposePermission(args: { account: Address; spender: Address; dailyAllowanceUnits: bigint; durationDays: number; now?: number }): SpendPermissionJson {
  const start = args.now ?? Math.floor(Date.now() / 1000);
  return {
    account: args.account, spender: args.spender, token: BASE_SEPOLIA_USDC,
    allowance: args.dailyAllowanceUnits.toString(), period: 86400, start, end: start + args.durationDays * 86400,
    salt: BigInt(`0x${crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`).toString(),
    extraData: "0x",
  };
}
