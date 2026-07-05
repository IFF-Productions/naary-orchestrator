import { describe, expect, it } from "vitest";
import { callRandom } from "../src/temporal/activities";

const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };
const gen = (cfg: Parameters<typeof callRandom>[0]) =>
  callRandom(cfg, meta).then((r) => r.value);

describe("callRandom", () => {
  it("uuid: a valid v4 UUID, unique per call", async () => {
    const a = (await gen({ operation: "uuid" })) as string;
    const b = (await gen({ operation: "uuid" })) as string;
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(a).not.toBe(b);
  });

  it("hex: length bytes → 2×length hex chars", async () => {
    expect((await gen({ operation: "hex", length: 8 })) as string).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });

  it("base64url: no +/=/ chars", async () => {
    const v = (await gen({ operation: "base64", length: 24 })) as string;
    expect(v).not.toMatch(/[+/=]/);
    expect(v.length).toBeGreaterThan(0);
  });

  it("alphanumeric: exactly `length` chars from [A-Za-z0-9]", async () => {
    const v = (await gen({ operation: "alphanumeric", length: 20 })) as string;
    expect(v).toMatch(/^[A-Za-z0-9]{20}$/);
  });

  it("int: within [min, max] inclusive; degenerate range → min", async () => {
    for (let i = 0; i < 50; i++) {
      const n = (await gen({ operation: "int", min: 5, max: 8 })) as number;
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(8);
    }
    expect(await gen({ operation: "int", min: 7, max: 7 })).toBe(7);
    expect(await gen({ operation: "int", min: 9, max: 3 })).toBe(9); // max<min → min
  });
});
