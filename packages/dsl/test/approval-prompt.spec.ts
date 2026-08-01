// What an approver READS (#1019) — and what must never appear in it.
//
// This text is rendered on the run detail, in the approval inbox, on the public signed
// approve/reject page, and posted to Slack, Teams and email. Three properties carry the whole
// change, so they are asserted here rather than left to a comment:
//
//   1. a `$secrets` reference stays LITERAL — against a ctx that ACTUALLY CARRIES `$secrets`,
//      because an absent key would prove nothing (the missing-ref rule below would keep the token
//      literal on its own and mask the real guard). The mutation this test exists to catch is the
//      removal of `isSecretRef`'s short-circuit in `resolveTemplateString`;
//   2. an unresolvable reference stays LEGIBLE — never blanked, never the word "undefined";
//   3. `$vars` DO resolve (the deliberate divergence from run-diagnosis — see approval-prompt.ts).
import { describe, expect, it } from "vitest";
import {
  resolveApprovalPrompt,
  resolvePromptText,
} from "../src/approval-prompt";

// A run ctx shaped like a real one: trigger output, a step output, seeded `$vars` — and a
// `$secrets` key the runtime never puts there, present ON PURPOSE (see 1 above).
const CTX = {
  __input: { issueNumber: 42 },
  $vars: { REGION: "eu-central", TEAM: "platform" },
  $secrets: { GH_TOKEN: "ghp-super-secret-value" },
  start: { issueNumber: 42, owner: "IFF-Productions", repo: "naary" },
  agent: {
    summary: "Adds the missing header",
    files: ["a.ts", "b.ts"],
    reviewer: null,
  },
};

describe("resolvePromptText — the reported prompt", () => {
  it("fills in every reference the run actually has", () => {
    expect(
      resolvePromptText(
        "Approve automated fix for issue #{{ start.issueNumber }}",
        CTX,
      ),
    ).toBe("Approve automated fix for issue #42");
    expect(
      resolvePromptText(
        "The coding agent prepared a fix for {{ start.owner }}/{{ start.repo }} " +
          "issue #{{ start.issueNumber }}.",
        CTX,
      ),
    ).toBe(
      "The coding agent prepared a fix for IFF-Productions/naary issue #42.",
    );
  });

  it("returns a whole-string token as text, not as a typed value", () => {
    expect(resolvePromptText("{{ start.issueNumber }}", CTX)).toBe("42");
    // An object renders as JSON rather than "[object Object]".
    expect(resolvePromptText("{{ agent.files }}", CTX)).toBe('["a.ts","b.ts"]');
  });
});

describe("resolvePromptText — never renders undefined", () => {
  it("keeps an unresolvable reference LITERAL instead of blanking it", () => {
    // The half-substituted sentence ("issue #") would read as fact. The token does not.
    expect(
      resolvePromptText("Approve fix for issue #{{ start.nope }}", CTX),
    ).toBe("Approve fix for issue #{{ start.nope }}");
    expect(resolvePromptText("{{ nosuchnode.field }}", CTX)).toBe(
      "{{ nosuchnode.field }}",
    );
  });

  it("never emits the word undefined", () => {
    for (const s of [
      "{{ start.nope }}",
      "a {{ missing }} b",
      "{{ agent.summary }} / {{ agent.nope }}",
    ]) {
      expect(resolvePromptText(s, CTX)).not.toContain("undefined");
    }
  });

  it("resolves a reference that IS present but empty — only a MISSING one survives", () => {
    // Matches collectUnresolved's rule: null/""/0 resolved, they are just empty.
    expect(resolvePromptText("Reviewer: {{ agent.reviewer }}", CTX)).toBe(
      "Reviewer: ",
    );
    expect(resolvePromptText("{{ agent.reviewer }}", CTX)).toBe("");
    expect(resolvePromptText("n={{ zero }}", { zero: 0 })).toBe("n=0");
    expect(resolvePromptText("s=[{{ empty }}]", { empty: "" })).toBe("s=[]");
  });
});

describe("resolvePromptText — $secrets stay literal", () => {
  // MUTATION GUARD. Delete the `isSecretRef(ref) ||` short-circuit from `resolveTemplateString`'s
  // `keep` in packages/dsl/src/template.ts and these must go RED: with `$secrets` present in ctx,
  // nothing else in this module keeps the token back.
  it("does not resolve a secret reference even when ctx carries $secrets", () => {
    const out = resolvePromptText(
      "Deploy with {{ $secrets.GH_TOKEN }} to {{ $vars.REGION }}?",
      CTX,
    );
    expect(out).toBe("Deploy with {{ $secrets.GH_TOKEN }} to eu-central?");
    expect(out).not.toContain("ghp-super-secret-value");
  });

  it("does not resolve a WHOLE-STRING secret reference either", () => {
    const out = resolvePromptText("{{ $secrets.GH_TOKEN }}", CTX);
    expect(out).toBe("{{ $secrets.GH_TOKEN }}");
    expect(out).not.toContain("ghp-super-secret-value");
  });

  it("leaks no secret VALUE through the whole prompt shape", () => {
    const prompt = resolveApprovalPrompt(
      {
        title: "Approve push with {{ $secrets.GH_TOKEN }}",
        instructions:
          "Token {{ $secrets.GH_TOKEN }} will be used for {{ start.repo }}.",
      },
      CTX,
    );
    expect(JSON.stringify(prompt)).not.toContain("ghp-super-secret-value");
    expect(prompt.title).toContain("{{ $secrets.GH_TOKEN }}");
    expect(prompt.instructions).toContain("{{ $secrets.GH_TOKEN }}");
    expect(prompt.instructions).toContain("naary");
  });
});

describe("resolvePromptText — $vars", () => {
  // The decision recorded in approval-prompt.ts: workspace variables are not secrets, the reader
  // is the tenant's own approver, and `contextFields` on the SAME record already resolve them.
  it("resolves workspace variables", () => {
    expect(
      resolvePromptText(
        "Promote to {{ $vars.REGION }} ({{ $vars.TEAM }})",
        CTX,
      ),
    ).toBe("Promote to eu-central (platform)");
  });

  it("keeps an unknown variable legible rather than blank", () => {
    expect(resolvePromptText("Region {{ $vars.NOPE }}", CTX)).toBe(
      "Region {{ $vars.NOPE }}",
    );
  });
});

describe("resolvePromptText — degrades, never fails", () => {
  it("returns the authored template when there is no ctx to resolve against", () => {
    const s = "Approve fix for issue #{{ start.issueNumber }}";
    expect(resolvePromptText(s, {})).toBe(s);
    expect(resolvePromptText(s, undefined)).toBe(s);
    expect(resolvePromptText(s, null)).toBe(s);
  });

  it("is total for hostile input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(resolvePromptText("{{ self }}", circular)).toBe("{{ self }}");
    expect(resolvePromptText("plain text", CTX)).toBe("plain text");
    expect(resolvePromptText("", CTX)).toBe("");
    expect(resolvePromptText(undefined as unknown as string, CTX)).toBe("");
    // An escaped `\{{` is a literal, exactly as the runtime treats it.
    expect(resolvePromptText("literal \\{{ not a token }}", CTX)).toBe(
      "literal {{ not a token }}",
    );
  });

  it("does not mutate the ctx it reads", () => {
    const before = JSON.stringify(CTX);
    resolvePromptText("{{ start.owner }}/{{ start.repo }} {{ nope }}", CTX);
    expect(JSON.stringify(CTX)).toBe(before);
  });
});

describe("resolveApprovalPrompt", () => {
  it("resolves BEFORE applying the defaults", () => {
    expect(
      resolveApprovalPrompt({ title: "  {{ start.repo }}  " }, CTX),
    ).toEqual({ title: "naary", instructions: null });
    // A title that resolves to nothing falls back to the standing default — not to "".
    expect(
      resolveApprovalPrompt({ title: "{{ agent.reviewer }}" }, CTX).title,
    ).toBe("Approval required");
  });

  it("defaults an absent / empty gate", () => {
    expect(resolveApprovalPrompt(undefined, CTX)).toEqual({
      title: "Approval required",
      instructions: null,
    });
    expect(
      resolveApprovalPrompt({ title: "   ", instructions: "" }, CTX),
    ).toEqual({ title: "Approval required", instructions: null });
  });

  it("keeps the authored text when the ctx is unavailable", () => {
    expect(
      resolveApprovalPrompt(
        {
          title: "Approve #{{ start.issueNumber }}",
          instructions: "for {{ start.repo }}",
        },
        {},
      ),
    ).toEqual({
      title: "Approve #{{ start.issueNumber }}",
      instructions: "for {{ start.repo }}",
    });
  });
});
