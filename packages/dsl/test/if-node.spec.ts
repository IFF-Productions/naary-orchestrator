import { describe, expect, it } from "vitest";
import { resolveIf } from "../src/if-node";
import type { IfNodeConfig } from "../src/types";

const ctx = { t: { priority: 7, topic: "invoice", open: true } };

describe("resolveIf", () => {
  it("AND: true only when every predicate holds", () => {
    const cfg: IfNodeConfig = {
      combine: "and",
      conditions: [
        { path: "t.priority", op: "gte", value: 5 },
        { path: "t.topic", op: "contains", value: "invoice" },
      ],
    };
    expect(resolveIf(cfg, ctx)).toEqual({ result: true });
    expect(
      resolveIf(
        {
          ...cfg,
          conditions: [
            ...cfg.conditions,
            { path: "t.open", op: "eq", value: false },
          ],
        },
        ctx,
      ),
    ).toEqual({ result: false });
  });

  it("OR: true when any predicate holds", () => {
    const cfg: IfNodeConfig = {
      combine: "or",
      conditions: [
        { path: "t.priority", op: "gte", value: 100 }, // false
        { path: "t.topic", op: "eq", value: "invoice" }, // true
      ],
    };
    expect(resolveIf(cfg, ctx)).toEqual({ result: true });
    expect(
      resolveIf(
        {
          combine: "or",
          conditions: [{ path: "t.priority", op: "gt", value: 100 }],
        },
        ctx,
      ),
    ).toEqual({ result: false });
  });

  it("defaults to AND, and empty conditions ⇒ false", () => {
    expect(
      resolveIf(
        { conditions: [{ path: "t.open", op: "eq", value: true }] },
        ctx,
      ),
    ).toEqual({ result: true });
    expect(resolveIf({ conditions: [] }, ctx)).toEqual({ result: false });
  });
});
