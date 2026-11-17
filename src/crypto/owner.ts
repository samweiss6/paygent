// Owner signing (Ed25519) for policy files and approvals, plus EIP-712 verification for
// hardware / root-wallet approvals above the hardware threshold.

import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey, type KeyObject } from "node:crypto";
import { verifyTypedData, type Hex } from "viem";

export interface OwnerKeyPair { publicKeyPem: string; privateKeyPem: string }

export function generateOwnerKey(): OwnerKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Canonical JSON: sorted keys, no whitespace. Signatures are over this form. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function signOwner(privateKeyPem: string, domain: string, payload: unknown): string {
  const key: KeyObject = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(`${domain}\n${canonicalJson(payload)}`), key).toString("base64");
}

export function verifyOwner(publicKeyPem: string, domain: string, payload: unknown, signatureB64: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(null, Buffer.from(`${domain}\n${canonicalJson(payload)}`), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

// Signature domains keep a policy signature from being replayed as an approval and vice versa.
export const DOMAIN_POLICY = "paygent/policy/v1";
export const DOMAIN_APPROVAL = "paygent/approval/v1";
export const DOMAIN_UNFREEZE = "paygent/unfreeze/v1";

export interface ApprovalPayload {
  payment_id: string;
  merchant: string;
  amount_cents: number;
  decision: "approve" | "reject";
  expires_at: string; // ISO time; approvals are short-lived
}

// EIP-712 typed data for hardware approvals. The owner signs this in their hardware wallet
// (or root smart wallet). Paygent can verify it but cannot produce it.
export const HARDWARE_APPROVAL_TYPES = {
  PaygentApproval: [
    { name: "paymentId", type: "string" },
    { name: "merchant", type: "string" },
    { name: "amountCents", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export const hardwareApprovalDomain = (chainId: number) => ({ name: "Paygent", version: "1", chainId });

export async function verifyHardwareApproval(args: {
  signer: Hex; chainId: number; signature: Hex;
  paymentId: string; merchant: string; amountCents: number; expiresAtUnix: number;
}): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: args.signer,
      domain: hardwareApprovalDomain(args.chainId),
      types: HARDWARE_APPROVAL_TYPES,
      primaryType: "PaygentApproval",
      message: {
        paymentId: args.paymentId, merchant: args.merchant,
        amountCents: BigInt(args.amountCents), expiresAt: BigInt(args.expiresAtUnix),
      },
      signature: args.signature,
    });
  } catch {
    return false;
  }
}
