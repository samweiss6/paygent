import { usdToCents } from "../money.ts";

/** True if changing `path` from `before` to `after` gives the agent more room. Unknown shapes count as loosening. */
export function looser(before: unknown, after: unknown, path: string): boolean {
  const stricterWhenTrue = ["require_for_new_merchant", "allow_only_listed"];
  const shrinkingIsLooser = path.endsWith("deny") || path === "blocked_keywords";
  if (typeof before === "string" && typeof after === "string" && /^\d/.test(before)) return usdToCents(after) > usdToCents(before);
  if (typeof before === "number" && typeof after === "number") return after > before;
  if (typeof before === "boolean" && typeof after === "boolean") {
    return stricterWhenTrue.some((k) => path.endsWith(k)) ? before && !after : !before && after;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return shrinkingIsLooser ? before.some((x) => !after.includes(x)) : after.some((x) => !before.includes(x));
  }
  return true;
}

