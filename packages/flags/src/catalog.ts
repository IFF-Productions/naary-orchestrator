/**
 * The app's known feature flags. OpenFeature's server SDK evaluates ONE key at a time,
 * so a "list all flags for this tenant" surface (GET /me/flags) needs an explicit catalog
 * to enumerate — there is no provider-agnostic "get everything". Each entry is the flag's
 * key (as configured in Flagsmith) + its SAFE code default (served when the provider is
 * unconfigured/unreachable, or the flag is absent). Booleans only for now.
 *
 * Add a flag here AND in Flagsmith; the default is the fail-safe value if Flagsmith is down.
 */
export interface FlagSpec {
  /** Flag key — must match the Flagsmith feature name exactly. */
  key: string;
  /** Value served when unconfigured/unreachable/absent. Choose the SAFE (usually off) value. */
  default: boolean;
  /** Human note — what this gates. Not sent anywhere; docs only. */
  description: string;
}

/** The canonical flag catalog. Keep it small + boolean until a real need appears. */
export const FLAG_CATALOG = {
  "chat-rag": {
    key: "chat-rag",
    default: false,
    description: "Enable the pgvector RAG retrieval step in the chat surface.",
  },
  "new-canvas-inspector": {
    key: "new-canvas-inspector",
    default: false,
    description: "Roll out the redesigned node inspector on the canvas.",
  },
  "canvas-import-tools": {
    key: "canvas-import-tools",
    // KILL-SWITCH: default ON so the import affordances stay visible everywhere Flagsmith
    // isn't wired (local dev + any deploy without a provider) — the flag can only HIDE a
    // shipped feature, never surprise-reveal one. The SPA gates the HTTP/GraphQL node's
    // cURL / OpenAPI-import / GraphQL-introspect buttons on it (#491).
    default: true,
    description:
      "Show the canvas HTTP/GraphQL node import tools (cURL import, OpenAPI import, GraphQL introspect).",
  },
} as const satisfies Record<string, FlagSpec>;

/** Union of known flag keys — call sites get compile-time checking of the key. */
export type FlagKey = keyof typeof FLAG_CATALOG;

export const ALL_FLAG_SPECS: readonly FlagSpec[] = Object.values(FLAG_CATALOG);
