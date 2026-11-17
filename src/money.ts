// Money helpers. All internal amounts are integer cents (number) or USDC base units (bigint, 6 decimals).

const USD_RE = /^(0|[1-9]\d{0,8})(\.\d{1,2})?$/;

/** Parse a decimal USD string like "23.40" into integer cents. Throws on anything else. */
export function usdToCents(usd: string): number {
  if (typeof usd !== "string" || !USD_RE.test(usd)) {
    throw new Error("amount must be a decimal string with at most 2 decimals, e.g. \"23.40\"");
  }
  const [whole, frac = ""] = usd.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function centsToUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** 1 cent = 10_000 USDC base units (USDC has 6 decimals). */
export function centsToUsdcUnits(cents: number): bigint {
  return BigInt(cents) * 10_000n;
}

export function usdcUnitsToCents(units: bigint): number {
  return Number(units / 10_000n);
}
