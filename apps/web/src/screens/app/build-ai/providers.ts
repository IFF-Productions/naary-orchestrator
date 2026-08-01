/**
 * Which model/agent the AI builder generates with — pure option derivation (no React, no I/O).
 *
 * The whole chain already supported this: the builder-turn DTO documents
 * `provider?: anthropic|openai|google|claude-code`, the controller forwards it, and
 * `sendBuilderTurn(id, message, provider)` takes it. Only the UI never passed one, so every
 * generation silently used whatever the server auto-picked — the first VALID configured credential,
 * API models before `claude-code`. This module turns that hidden choice into a visible one.
 *
 * `null` means "let the server choose" and stays the default, so the picker changes nothing until
 * someone actually uses it.
 */
import type { ProviderCredential } from "../../../lib/api";

/** The provider ids the generator accepts (mirrors GEN_PROVIDERS + CLAUDE_CODE server-side). */
export const AI_BUILDER_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "claude-code",
] as const;
export type AiBuilderProvider = (typeof AI_BUILDER_PROVIDERS)[number];

/** Display copy per provider. The model names match the server's `GEN_DEFAULT_MODEL`. */
const LABELS: Record<AiBuilderProvider, { label: string; hint: string }> = {
  anthropic: { label: "Claude", hint: "Anthropic API · claude-opus-4-8" },
  openai: { label: "GPT", hint: "OpenAI API · gpt-4.1" },
  google: { label: "Gemini", hint: "Google API · gemini-2.5-pro" },
  "claude-code": {
    label: "Claude Code",
    hint: "Runs the local claude CLI as an agent",
  },
};

export interface ProviderOption {
  id: AiBuilderProvider;
  label: string;
  hint: string;
  /** False when a credential exists but failed validation — offered, but not selectable. */
  selectable: boolean;
}

/**
 * The options to offer, derived from the workspace's configured credentials.
 *
 * A configured-but-INVALID credential is listed and disabled rather than hidden. Hiding it would
 * answer "why isn't my OpenAI key in the list?" with silence, when the actual answer — the key failed
 * validation — is something the user can fix. Anything not configured at all is simply absent; there's
 * nothing actionable to say about a provider they never set up.
 *
 * Ordered by `AI_BUILDER_PROVIDERS`, matching the server's own auto-select precedence (API models
 * first, `claude-code` last) so the list reads in the same order the server would have chosen.
 */
export function providerOptions(
  credentials: ProviderCredential[] | null,
): ProviderOption[] {
  if (!credentials) return [];
  const byId = new Map(credentials.map((c) => [c.provider, c.isValid]));
  const out: ProviderOption[] = [];
  for (const id of AI_BUILDER_PROVIDERS) {
    if (!byId.has(id)) continue;
    out.push({ id, ...LABELS[id], selectable: byId.get(id) === true });
  }
  return out;
}

/**
 * Resolve a remembered choice against what's currently offerable.
 *
 * Returns null (⇒ server auto-select) when the stored provider is unknown, no longer configured, or
 * now invalid. Sending a stale id would 400 — a credential removed since the choice was made, or a key
 * that has since failed validation — and a 400 on a remembered preference is the most confusing kind of
 * failure, because the user didn't choose anything this time.
 */
export function resolveStoredProvider(
  stored: string | null,
  options: ProviderOption[],
): AiBuilderProvider | null {
  if (!stored) return null;
  const match = options.find((o) => o.id === stored && o.selectable);
  return match ? match.id : null;
}

/**
 * What to tell the user when no provider is configured at all.
 *
 * Returned rather than thrown: generation genuinely can't work, and the server's own error says the
 * same thing, but saying it BEFORE they type a prompt is the difference between a dead end and a next
 * step. Null when at least one provider is usable.
 */
export function providerSetupHint(options: ProviderOption[]): string | null {
  if (options.some((o) => o.selectable)) return null;
  return options.length > 0
    ? "Every configured AI provider key failed validation — re-add one in Integrations to generate."
    : "Add an AI provider key (Anthropic, OpenAI or Google) or a Claude Code credential in Integrations to generate workflows.";
}

/**
 * The remembered choice — ONE key, shared by the Build with AI screen and the canvas panel.
 *
 * They are the same conversation on two surfaces, so "generate with Claude Code" chosen in one is
 * an answer for the other; two keys would make the same question get asked twice. localStorage can
 * THROW (sandboxed iframe, private mode) and a preference is never worth failing a screen over, so
 * both helpers swallow.
 */
const PROVIDER_KEY = "naary-build-ai-provider";

export function readStoredProvider(): string | null {
  try {
    return localStorage.getItem(PROVIDER_KEY);
  } catch {
    return null;
  }
}

export function writeStoredProvider(value: AiBuilderProvider | null): void {
  try {
    if (value) localStorage.setItem(PROVIDER_KEY, value);
    else localStorage.removeItem(PROVIDER_KEY);
  } catch {
    /* preference only */
  }
}
