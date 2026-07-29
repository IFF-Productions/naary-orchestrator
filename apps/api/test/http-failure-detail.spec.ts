import { describe, expect, it } from "vitest";
import { defaultPayloadConverter } from "@temporalio/client";
import {
  httpFailureFrom,
  mapHistoryEvent,
  sanitizeHttpFailure,
} from "../src/executions/executions.helpers";
import type { RawFailure } from "../src/executions/executions.types";

/**
 * The read half of #916: a failing HTTP-ish node attaches a redacted request/response to its
 * `ApplicationFailure` details, and this is where it gets back out of Temporal history.
 *
 * Two things are under test. That the CAUSE WALK finds the right layer — Temporal wraps the
 * activity's failure, and a retryable wrapper carries `{statusCode}` details that must not
 * short-circuit the search. And that the decoded value is REBUILT rather than trusted: it crosses
 * from a payload into an API response, so a wrong shape has to be dropped, not forwarded.
 */

const CAPTURE = {
  request: {
    method: "POST",
    url: "https://api.github.com/repos/o/r/issues",
    headers: {
      authorization: "[REDACTED]",
      "content-type": "application/json",
    },
    body: { text: '{"title":"x"}', truncated: false, bytes: 13 },
  },
  response: {
    status: 404,
    statusText: "Not Found",
    headers: { "content-type": "application/json" },
    body: { text: '{"message":"Not Found"}', truncated: false, bytes: 23 },
  },
};

/** An ApplicationFailure layer as it appears in raw history: details are Payloads, not a value. */
function appFailure(message: string, details?: unknown): RawFailure {
  return {
    message,
    applicationFailureInfo: {
      type: "INTEGRATION_WRITE_FAILED",
      ...(details === undefined
        ? {}
        : {
            details: {
              payloads: [defaultPayloadConverter.toPayload(details)],
            },
          }),
    },
  };
}

describe("httpFailureFrom — walking the cause chain", () => {
  it("finds the capture under Temporal's wrappers", () => {
    const chain: RawFailure = {
      message: "Workflow execution failed",
      cause: {
        message: "Activity task failed",
        cause: appFailure("integration failed: 404", {
          httpStatus: 404,
          http: CAPTURE,
        }),
      },
    };
    expect(httpFailureFrom(chain)).toEqual(CAPTURE);
  });

  it("does not stop at a details-bearing layer that has no capture", () => {
    // `toSanitizedRetryable` attaches `{statusCode}`; stopping on "has details" would miss
    // the real capture one level down.
    const chain: RawFailure = {
      ...appFailure("transient", { statusCode: 500 }),
      cause: appFailure("integration failed", { http: CAPTURE }),
    };
    expect(httpFailureFrom(chain)).toEqual(CAPTURE);
  });

  it("returns undefined for a failure that captured nothing", () => {
    expect(
      httpFailureFrom(appFailure("agent failed", { httpStatus: 401 })),
    ).toBeUndefined();
    expect(httpFailureFrom({ message: "plain" })).toBeUndefined();
    expect(httpFailureFrom(undefined)).toBeUndefined();
  });

  it("is total — an undecodable payload doesn't fail the history read", () => {
    const broken: RawFailure = {
      message: "x",
      applicationFailureInfo: { details: { payloads: [{ nonsense: true }] } },
    };
    expect(() => httpFailureFrom(broken)).not.toThrow();
    expect(httpFailureFrom(broken)).toBeUndefined();
  });

  it("terminates on a cyclic chain", () => {
    const a: RawFailure = { message: "a" };
    a.cause = a;
    expect(httpFailureFrom(a)).toBeUndefined();
  });
});

describe("sanitizeHttpFailure — rebuild, never forward", () => {
  it("drops a capture with no usable request", () => {
    expect(sanitizeHttpFailure(undefined)).toBeUndefined();
    expect(sanitizeHttpFailure({})).toBeUndefined();
    expect(sanitizeHttpFailure({ request: { method: "GET" } })).toBeUndefined();
  });

  it("drops non-string header values rather than stringifying them", () => {
    const out = sanitizeHttpFailure({
      request: {
        method: "GET",
        url: "https://x/y",
        headers: { ok: "v", nested: { a: 1 }, num: 5 },
      },
    });
    expect(out?.request.headers).toEqual({ ok: "v" });
  });

  it("trusts the worker's `truncated`, never re-derives it from text.length", () => {
    // Redaction shrinks `text` while `bytes` stays the wire length, so `text.length < bytes`
    // is true for most captures — deriving truncation from it labelled full bodies truncated.
    const out = sanitizeHttpFailure({
      request: {
        method: "GET",
        url: "https://x/y",
        headers: {},
        body: { text: "short", truncated: false, bytes: 4000 },
      },
    });
    expect(out?.request.body).toEqual({
      text: "short",
      truncated: false,
      bytes: 4000,
    });
  });

  it("keeps the nodeId so the UI can attribute the call", () => {
    const out = sanitizeHttpFailure({
      nodeId: "integration-1",
      request: { method: "GET", url: "https://x/y", headers: {} },
    });
    expect(out?.nodeId).toBe("integration-1");
  });

  it("drops a response with no numeric status (never invents a status 0)", () => {
    const out = sanitizeHttpFailure({
      request: { method: "GET", url: "https://x/y", headers: {} },
      response: { statusText: "Not Found" },
    });
    expect(out?.response).toBeUndefined();
  });

  it("drops the WHOLE capture when it is oversized — never half-shows one", () => {
    expect(
      sanitizeHttpFailure({
        request: {
          method: "GET",
          url: "https://x/y",
          headers: Object.fromEntries(
            Array.from({ length: 60 }, (_, i) => [`h${i}`, "v".repeat(300)]),
          ),
        },
      }),
    ).toBeUndefined();
  });
});

describe("mapHistoryEvent", () => {
  it("attaches the capture to an activityTaskFailed event", () => {
    const ev = mapHistoryEvent({
      eventId: 7,
      activityTaskFailedEventAttributes: {
        failure: appFailure("integration failed: 404", { http: CAPTURE }),
      },
    });
    expect(ev).toMatchObject({
      kind: "error",
      detail: "integration failed: 404",
      http: CAPTURE,
    });
  });

  it("omits `http` entirely when the failure captured no call", () => {
    const ev = mapHistoryEvent({
      eventId: 7,
      activityTaskFailedEventAttributes: {
        failure: { message: "agent failed" },
      },
    });
    expect(ev).toEqual({
      id: 7,
      at: null,
      kind: "error",
      label: "Activity failed",
      detail: "agent failed",
    });
    expect(ev && "http" in ev).toBe(false);
  });
});
