import { describe, expect, it } from "vitest";
import { runAgentStub } from "../src/temporal/activities";

describe("runAgentStub", () => {
  it("returns the canned text and the serialized input", async () => {
    const input = { hello: "world" };
    const out = await runAgentStub({ canned: "hello from stub agent" }, input);

    expect(out).toContain("hello from stub agent");
    expect(out).toContain(JSON.stringify(input));
    expect(out).toBe('[stub-agent] hello from stub agent :: {"hello":"world"}');
  });
});
