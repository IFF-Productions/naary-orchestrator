import { afterEach, describe, expect, it } from "vitest";
import {
  __resetActivityGauge,
  activeActivities,
  countActivities,
} from "../src/temporal/activity-gauge";

afterEach(() => __resetActivityGauge());

describe("countActivities gauge", () => {
  it("counts an in-flight async activity and releases the slot when it settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const wrapped = countActivities({
      slow: async () => {
        await gate;
        return "done";
      },
    });

    expect(activeActivities()).toBe(0);
    const p = wrapped.slow();
    expect(activeActivities()).toBe(1); // executing now
    release();
    await expect(p).resolves.toBe("done");
    expect(activeActivities()).toBe(0); // released
  });

  it("tracks concurrent activities", async () => {
    let r1!: () => void;
    let r2!: () => void;
    const wrapped = countActivities({
      a: () => new Promise<void>((r) => (r1 = r)),
      b: () => new Promise<void>((r) => (r2 = r)),
    });
    const pa = wrapped.a();
    const pb = wrapped.b();
    expect(activeActivities()).toBe(2);
    r1();
    await pa;
    expect(activeActivities()).toBe(1);
    r2();
    await pb;
    expect(activeActivities()).toBe(0);
  });

  it("releases the slot on a rejected activity", async () => {
    const wrapped = countActivities({
      boom: async () => {
        throw new Error("nope");
      },
    });
    await expect(wrapped.boom()).rejects.toThrow("nope");
    expect(activeActivities()).toBe(0);
  });

  it("releases the slot on a synchronous throw and preserves the error", () => {
    const wrapped = countActivities({
      sync: () => {
        throw new Error("sync-boom");
      },
    });
    expect(() => wrapped.sync()).toThrow("sync-boom");
    expect(activeActivities()).toBe(0);
  });

  it("passes non-function properties through untouched", () => {
    const wrapped = countActivities({ __deps: { x: 1 }, fn: async () => 1 });
    expect(wrapped.__deps).toEqual({ x: 1 });
  });
});
