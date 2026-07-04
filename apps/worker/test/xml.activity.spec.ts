import { beforeEach, describe, expect, it } from "vitest";
import { __setObjectStore, MemoryObjectStore } from "@naary/storage";
import { callXml } from "../src/temporal/activities";

const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

beforeEach(() => {
  __setObjectStore(new MemoryObjectStore());
});

describe("callXml", () => {
  it("parse: XML string → object", async () => {
    const r = await callXml(
      { operation: "parse" },
      "<note><to>Ada</to><n>2</n></note>",
      meta,
    );
    expect(r.status).toBe("ok");
    expect(r.result).toEqual({ note: { to: "Ada", n: 2 } });
  });

  it("build: object → { xml } string", async () => {
    const r = await callXml(
      { operation: "build" },
      { note: { to: "Bo" } },
      meta,
    );
    const xml = (r.result as { xml: string }).xml;
    expect(xml).toContain("<note>");
    expect(xml).toContain("<to>Bo</to>");
  });

  it("round-trips build → parse", async () => {
    const built = await callXml(
      { operation: "build" },
      { root: { a: "1", b: "two" } },
      meta,
    );
    const parsed = await callXml(
      { operation: "parse" },
      (built.result as { xml: string }).xml,
      meta,
    );
    expect(parsed.result).toEqual({ root: { a: 1, b: "two" } });
  });
});
