import { describe, expect, it } from "vitest";
import { createSseParser } from "../src/lib/sse";

describe("createSseParser", () => {
  it("parses a single complete frame", () => {
    const p = createSseParser();
    expect(p.push('event: result\ndata: {"a":1}\n\n')).toEqual([
      { event: "result", data: '{"a":1}' },
    ]);
  });

  it("buffers a frame split across chunks (even mid-line)", () => {
    const p = createSseParser();
    expect(p.push("event: res")).toEqual([]);
    expect(p.push("ult\ndata: hel")).toEqual([]);
    expect(p.push("lo\n\n")).toEqual([{ event: "result", data: "hello" }]);
  });

  it("returns multiple frames arriving in one chunk", () => {
    const p = createSseParser();
    expect(p.push("data: one\n\nevent: error\ndata: two\n\n")).toEqual([
      { event: "message", data: "one" },
      { event: "error", data: "two" },
    ]);
  });

  it("comment-only blocks (heartbeats) yield no frames", () => {
    const p = createSseParser();
    expect(p.push(": connected\n\n: ping\n\n")).toEqual([]);
    // ...and don't corrupt a following real frame.
    expect(p.push(": ping\n\ndata: ok\n\n")).toEqual([
      { event: "message", data: "ok" },
    ]);
  });

  it("normalizes CRLF line endings", () => {
    const p = createSseParser();
    expect(p.push("event: result\r\ndata: x\r\n\r\n")).toEqual([
      { event: "result", data: "x" },
    ]);
  });

  it("handles a CRLF pair split across chunks (buffer ends \\r, next starts \\n)", () => {
    const p = createSseParser();
    expect(p.push("event: result\r")).toEqual([]);
    expect(p.push("\ndata: x\r\n\r")).toEqual([]);
    expect(p.push("\n")).toEqual([{ event: "result", data: "x" }]);
  });

  it("treats a lone \\r as a line break (SSE spec)", () => {
    const p = createSseParser();
    expect(p.push("event: result\rdata: x\r\r")).toEqual([]);
    // held-back trailing \r resolves as a bare line break on the next push
    expect(p.push("data: y\n\n")).toEqual([
      { event: "result", data: "x" },
      { event: "message", data: "y" },
    ]);
  });

  it("joins multi-line data with newlines", () => {
    const p = createSseParser();
    expect(p.push("data: line1\ndata: line2\n\n")).toEqual([
      { event: "message", data: "line1\nline2" },
    ]);
  });

  it('defaults the event name to "message" and strips one leading space after the colon', () => {
    const p = createSseParser();
    expect(p.push("data:no-space\n\ndata:  two-spaces\n\n")).toEqual([
      { event: "message", data: "no-space" },
      { event: "message", data: " two-spaces" },
    ]);
    // Same one-space rule for event: names — never trim all leading whitespace.
    expect(p.push("event:  spaced\ndata: x\n\n")).toEqual([
      { event: " spaced", data: "x" },
    ]);
  });
});
