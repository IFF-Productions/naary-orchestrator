import { ConnectCallbackError } from "@naary/connections";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Spy on the alerting sink so we can assert WHAT gets escalated vs stays a quiet warn. Preserve
// every other real export (connect-callback-error's import graph pulls in the real package).
const { captureErrorMock } = vi.hoisted(() => ({ captureErrorMock: vi.fn() }));
vi.mock("@naary/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@naary/observability")>();
  return { ...actual, captureError: captureErrorMock };
});

import { reportConnectCallbackFailure } from "../src/connections/connect-callback-error";

const fakeLogger = () => ({ warn: vi.fn(), error: vi.fn() });

describe("reportConnectCallbackFailure", () => {
  beforeEach(() => captureErrorMock.mockClear());

  it("a user-recoverable state error (the #419/#426 class) is a WARN only — never alerted", () => {
    for (const reason of [
      "missing_params",
      "unknown_or_expired",
      "expired",
    ] as const) {
      const log = fakeLogger();
      reportConnectCallbackFailure(
        new ConnectCallbackError(reason, `state ${reason}`),
        log,
        "GitHub App install callback",
      );
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.error).not.toHaveBeenCalled();
      expect(captureErrorMock).not.toHaveBeenCalled();
    }
  });

  it("a GENUINE fault is an ERROR that IS captured (an outage isn't masked by the redirect)", () => {
    const log = fakeLogger();
    const boom = new Error("store down");
    reportConnectCallbackFailure(boom, log, "OAuth callback");
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(captureErrorMock).toHaveBeenCalledWith(boom, {
      where: "OAuth callback",
    });
  });
});
