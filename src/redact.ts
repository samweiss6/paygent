// Redaction applied to everything written to logs, the audit log, and adapter log output.
// Defense in depth: the code paths that handle PANs never pass them to loggers in the first place.

const SECRET_KEYS = /^(pan|cvv|cvc|card_?number|number|exp(iry|iration)?(_month|_year)?|private_?key|secret|api_?key|token|passphrase|password|authorization|signature_secret)$/i;
const PAN_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const HEX_KEY_RE = /\b0x[0-9a-fA-F]{64}\b/g;
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export function redactString(s: string): string {
  return s
    .replace(PEM_RE, "[redacted-key]")
    .replace(HEX_KEY_RE, "[redacted-key]")
    .replace(PAN_RE, (m) => (luhnValid(m.replace(/\D/g, "")) ? "[redacted-pan]" : m));
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) && v !== null && v !== undefined && typeof v !== "boolean" ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}
