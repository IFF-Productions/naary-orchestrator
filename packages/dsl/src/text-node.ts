import { getByPath } from "./mcp-args";
import type { TextNodeConfig } from "./types";

/**
 * Resolve a `text` node's output from the run context. One string operation on the value at
 * `from`/`path`, returned as `{ result }`. PURE + deterministic — coerces the input to a
 * string for most ops (`join` expects an array); `RegExp` is deterministic and an invalid
 * pattern fails closed to `null` (never a throw into the workflow task). Runs in the
 * interpreter like the other pure transforms.
 */
export function resolveText(
  config: TextNodeConfig,
  ctx: Record<string, unknown>,
): { result: string | string[] | number | null } {
  const raw = getByPath(ctx[config.from], config.path);
  const s = raw == null ? "" : String(raw);

  switch (config.operation) {
    case "upper":
      return { result: s.toUpperCase() };
    case "lower":
      return { result: s.toLowerCase() };
    case "trim":
      return { result: s.trim() };
    case "length":
      return { result: s.length };
    case "split":
      return { result: s.split(config.separator ?? ",") };
    case "join":
      return {
        result: (Array.isArray(raw) ? raw : [raw])
          .map((v) => (v == null ? "" : String(v)))
          .join(config.separator ?? ","),
      };
    case "substring":
      return { result: s.substring(config.start ?? 0, config.end) };
    case "replace":
      if (config.useRegex) {
        try {
          return {
            result: s.replace(
              new RegExp(config.search ?? "", "g"),
              config.replacement ?? "",
            ),
          };
        } catch {
          return { result: null };
        }
      }
      return {
        result: s.split(config.search ?? "").join(config.replacement ?? ""),
      };
    case "regexExtract":
      try {
        const m = s.match(new RegExp(config.search ?? ""));
        return { result: m ? (m[config.group ?? 0] ?? null) : null };
      } catch {
        return { result: null };
      }
    default:
      return { result: null };
  }
}
