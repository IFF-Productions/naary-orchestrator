import { describe, expect, it } from "vitest";
import {
  AI_BUILDER_PROVIDERS,
  providerOptions,
  providerSetupHint,
  resolveStoredProvider,
} from "../src/screens/app/build-ai/providers";

/**
 * Which model/agent the AI builder generates with.
 *
 * The chain already accepted a provider end to end (builder-turn DTO → controller →
 * `sendBuilderTurn`); the UI just always passed `undefined`, so every generation used whatever the
 * server auto-picked. These rules turn that into a visible choice without changing the default.
 */
const cred = (provider: string, isValid = true) => ({ provider, isValid });

describe("providerOptions", () => {
  it("offers nothing while credentials are still loading", () => {
    expect(providerOptions(null)).toEqual([]);
  });

  it("offers only providers the workspace has configured", () => {
    const out = providerOptions([cred("anthropic"), cred("google")]);
    expect(out.map((o) => o.id)).toEqual(["anthropic", "google"]);
  });

  /**
   * Ordered like the server's own auto-select precedence (API models first, `claude-code` last), so
   * the list reads in the same order the server would have chosen — not in credential-creation order.
   */
  it("orders options by the generator's precedence, not by input order", () => {
    const out = providerOptions([
      cred("claude-code"),
      cred("google"),
      cred("anthropic"),
      cred("openai"),
    ]);
    expect(out.map((o) => o.id)).toEqual([
      "anthropic",
      "openai",
      "google",
      "claude-code",
    ]);
  });

  /**
   * A configured-but-invalid key is LISTED and disabled, not hidden. Hiding it would answer "why isn't
   * my OpenAI key in the list?" with silence, when the real answer — validation failed — is fixable.
   */
  it("lists an invalid credential as unselectable rather than hiding it", () => {
    const out = providerOptions([cred("openai", false)]);
    expect(out).toHaveLength(1);
    expect(out[0].selectable).toBe(false);
  });

  it("ignores a credential that isn't a generator provider", () => {
    // Integrations stores connection credentials too (github, slack, …) — only model providers and
    // the claude-code agent can generate.
    expect(providerOptions([cred("github"), cred("slack")])).toEqual([]);
  });

  it("carries a label and a hint naming the actual model", () => {
    const [anthropic] = providerOptions([cred("anthropic")]);
    expect(anthropic.label).toBe("Claude");
    // The hint must name the model the server will really use, or it's decoration.
    expect(anthropic.hint).toContain("claude-opus-4-8");
  });

  it("covers every provider the generator accepts", () => {
    const out = providerOptions(AI_BUILDER_PROVIDERS.map((p) => cred(p)));
    expect(out.map((o) => o.id)).toEqual([...AI_BUILDER_PROVIDERS]);
    for (const o of out) {
      expect(o.label.length, o.id).toBeGreaterThan(0);
      expect(o.hint.length, o.id).toBeGreaterThan(0);
    }
  });
});

describe("resolveStoredProvider", () => {
  const options = providerOptions([cred("anthropic"), cred("openai", false)]);

  it("returns null with nothing stored (⇒ the server auto-selects, today's behaviour)", () => {
    expect(resolveStoredProvider(null, options)).toBeNull();
    expect(resolveStoredProvider("", options)).toBeNull();
  });

  it("restores a still-valid choice", () => {
    expect(resolveStoredProvider("anthropic", options)).toBe("anthropic");
  });

  /**
   * The cases that matter. A remembered provider whose credential was REMOVED, or which has since
   * failed validation, would 400 on send — and a 400 on a preference the user didn't re-choose is the
   * most confusing failure available. Fall back to auto instead.
   */
  it("falls back to auto when the stored provider is no longer configured", () => {
    expect(resolveStoredProvider("google", options)).toBeNull();
  });

  it("falls back to auto when the stored provider is configured but invalid", () => {
    expect(resolveStoredProvider("openai", options)).toBeNull();
  });

  it("falls back to auto for a junk stored value", () => {
    expect(resolveStoredProvider("not-a-provider", options)).toBeNull();
    expect(resolveStoredProvider("anthropic", [])).toBeNull();
  });
});

describe("providerSetupHint", () => {
  it("is silent when at least one provider is usable", () => {
    expect(providerSetupHint(providerOptions([cred("anthropic")]))).toBeNull();
  });

  /** Said BEFORE they type a prompt: the same fact as the server's error, but as a next step. */
  it("tells the user to add a key when none is configured", () => {
    const hint = providerSetupHint([]);
    expect(hint).toMatch(/Integrations/);
    expect(hint).toMatch(/Anthropic|OpenAI|Google/);
  });

  /** Distinct copy: "add a key" is wrong advice when they already added one that's broken. */
  it("distinguishes 'all keys invalid' from 'no keys at all'", () => {
    const invalidOnly = providerOptions([
      cred("anthropic", false),
      cred("openai", false),
    ]);
    const hint = providerSetupHint(invalidOnly);
    expect(hint).toMatch(/failed validation/i);
    expect(hint).not.toBe(providerSetupHint([]));
  });
});
