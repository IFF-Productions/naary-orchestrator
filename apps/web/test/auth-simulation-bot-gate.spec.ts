import { describe, expect, it } from "vitest";
import {
  BOT_GATE_LABEL,
  botGateStatus,
  nodeStatuses,
  type Stage,
} from "../src/screens/auth/simulation";

/**
 * The auth screen's bot-protection gate, drawn as a SIDE process off the trigger.
 *
 * `simulation.ts` states its own rule up front: *"the simulation never fakes success"* — `done` only
 * ever means the real auth promise resolved. The side gate has to honour that, so its status is derived
 * from the same stage machine as the five main nodes rather than animating on a timer.
 */
const STAGES: Stage[] = [
  null,
  "verify",
  "paused",
  "provision",
  "done",
  "failed",
];

describe("botGateStatus", () => {
  it("is idle before anything is submitted", () => {
    expect(botGateStatus({ stage: null })).toBe("idle");
  });

  /** The gate is what runs FIRST on submit — it decides whether the request is admitted at all. */
  it("runs during verify", () => {
    expect(botGateStatus({ stage: "verify" })).toBe("running");
  });

  it.each(["paused", "provision", "done"] as const)(
    "is done once the flow has moved past verify (%s)",
    (stage) => {
      expect(botGateStatus({ stage })).toBe("done");
    },
  );

  /**
   * The one worth stating explicitly: a REJECTED CREDENTIAL is not a rejected bot check. Drawing the
   * gate as failed would blame the wrong node for the outcome — the request was admitted; the password
   * was wrong.
   */
  it("stays DONE on a failed sign-in, because the gate is not what failed", () => {
    expect(botGateStatus({ stage: "failed" })).toBe("done");
  });

  it("never returns a status the card can't render", () => {
    const renderable = [
      "idle",
      "active",
      "running",
      "paused",
      "done",
      "failed",
    ];
    for (const stage of STAGES) {
      expect(renderable).toContain(botGateStatus({ stage }));
    }
  });
});

describe("it stays a SIDE process", () => {
  /** Five nodes in the chain, still — the gate is drawn beside the trigger, not appended to it. */
  it.each(STAGES)("nodeStatuses is unchanged at stage %s", (stage) => {
    const statuses = nodeStatuses({
      mode: "signup",
      provider: null,
      stage,
      focus: "",
      name: "Ada",
      email: "ada@acme.io",
      password: "secret1",
    });
    expect(statuses).toHaveLength(5);
  });

  it("names the mechanism, so the card isn't a vague badge", () => {
    expect(BOT_GATE_LABEL[0]).toBe("Bot protection");
    expect(BOT_GATE_LABEL[1]).toMatch(/turnstile/i);
    // "side" in the sublabel is the whole point of the node.
    expect(BOT_GATE_LABEL[1]).toMatch(/side/i);
  });
});
