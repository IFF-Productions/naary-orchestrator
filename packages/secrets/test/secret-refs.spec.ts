import { describe, expect, it, vi } from "vitest";
import {
  hasSecretRef,
  resolveSecretsInString,
  secretNamesIn,
} from "../src/secret-refs";

describe("hasSecretRef / secretNamesIn", () => {
  it("detects `{{ $secrets.NAME }}` tokens and extracts distinct names in order", () => {
    expect(hasSecretRef("Bearer {{ $secrets.GH_TOKEN }}")).toBe(true);
    expect(hasSecretRef("Bearer {{ hook.token }}")).toBe(false); // not a secret ref
    expect(hasSecretRef("plain")).toBe(false);
    expect(
      secretNamesIn("{{ $secrets.A }} {{ $secrets.B }} {{ $secrets.A }}"),
    ).toEqual(["A", "B"]);
  });

  it("only matches identifier names (no dots/spaces)", () => {
    expect(hasSecretRef("{{ $secrets.a.b }}")).toBe(false);
    expect(hasSecretRef("{{ $secrets. }}")).toBe(false);
    expect(hasSecretRef("{{ $secretsX }}")).toBe(false);
  });
});

describe("resolveSecretsInString", () => {
  it("substitutes each token with its resolved value", async () => {
    const resolveOne = vi.fn(async (n: string) => `<${n}>`);
    expect(
      await resolveSecretsInString(
        "Basic {{ $secrets.USER }}:{{ $secrets.PASS }}",
        resolveOne,
      ),
    ).toBe("Basic <USER>:<PASS>");
  });

  it("resolves each DISTINCT name exactly once, even when repeated", async () => {
    const resolveOne = vi.fn(async (n: string) => `v-${n}`);
    const out = await resolveSecretsInString(
      "{{ $secrets.T }}-{{ $secrets.T }}",
      resolveOne,
    );
    expect(out).toBe("v-T-v-T");
    expect(resolveOne).toHaveBeenCalledTimes(1); // deduped
  });

  it("passes through a string with no secret tokens (never calls resolveOne)", async () => {
    const resolveOne = vi.fn();
    expect(await resolveSecretsInString("no tokens here", resolveOne)).toBe(
      "no tokens here",
    );
    expect(resolveOne).not.toHaveBeenCalled();
  });

  it("propagates a resolver rejection (missing secret) instead of blanking it", async () => {
    const resolveOne = vi.fn(async () => {
      throw new Error("missing");
    });
    await expect(
      resolveSecretsInString("{{ $secrets.NOPE }}", resolveOne),
    ).rejects.toThrow("missing");
  });
});
