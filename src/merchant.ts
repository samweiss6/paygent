// Merchant identity is a registrable domain. We do not ship the full Public Suffix List
// (keeps dependencies at zero); the multi-part suffixes below cover common cases. A merchant
// on an unlisted multi-part suffix gets matched one label too broadly, which only matters for
// allow/deny matching and is documented in the threat model.

const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp",
  "com.br", "com.mx", "co.in", "co.za", "com.sg", "com.hk", "com.cn", "co.kr",
]);

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export class MerchantError extends Error {}

/**
 * Normalize agent-supplied merchant input to a lowercase hostname.
 * Accepts "example.com", "https://shop.example.com/cart". Rejects IPs, localhost,
 * userinfo tricks ("good.com@evil.com"), non-ASCII (homoglyphs), ports, and single labels.
 */
export function normalizeMerchant(input: string): string {
  if (typeof input !== "string") throw new MerchantError("merchant must be a string");
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 253) throw new MerchantError("merchant length invalid");
  // Non-ASCII is rejected outright: punycode/IDN merchants must be given in xn-- form.
  if (/[^\x21-\x7e]/.test(raw)) throw new MerchantError("merchant must be ASCII (use xn-- form for IDN)");

  let host: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new MerchantError("merchant URL invalid"); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new MerchantError("merchant URL scheme must be http(s)");
    if (url.username || url.password) throw new MerchantError("merchant URL must not contain credentials");
    if (url.port) throw new MerchantError("merchant URL must not contain a port");
    host = url.hostname;
  } else {
    if (/[/@:?#\\]/.test(raw)) throw new MerchantError("merchant must be a domain or https URL");
    host = raw;
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("[")) throw new MerchantError("IP addresses are not merchants");
  const labels = host.split(".");
  if (labels.length < 2) throw new MerchantError("merchant must be a full domain");
  if (!labels.every((l) => LABEL_RE.test(l))) throw new MerchantError("merchant contains an invalid label");
  if (["localhost", "local", "internal", "test", "invalid", "example", "onion"].includes(labels.at(-1)!)) {
    throw new MerchantError("reserved or local top-level domain");
  }
  return host;
}

export function registrableDomain(host: string): string {
  const labels = host.split(".");
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && MULTI_PART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

/**
 * Pattern forms: "example.com" (that registrable domain and all its subdomains)
 * or "*.example.com" (same meaning, accepted for readability).
 */
export function merchantMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase().replace(/^\*\./, "");
  return host === p || host.endsWith("." + p) || registrableDomain(host) === p;
}

/** True if a page hostname belongs to the merchant's registrable domain. */
export function sameMerchant(pageHost: string, merchantHost: string): boolean {
  return registrableDomain(pageHost.toLowerCase()) === registrableDomain(merchantHost);
}
