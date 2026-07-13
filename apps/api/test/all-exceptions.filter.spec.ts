import { HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";

/** Minimal ArgumentsHost stub exposing the Express req/res the filter reads. */
function host(req: unknown, res: unknown) {
  return {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => req,
    }),
  } as never;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(b: unknown) {
      res.body = b;
    },
  };
  return res;
}

describe("AllExceptionsFilter", () => {
  it("passes an HttpException through with its status + body (no generic 500)", () => {
    const res = makeRes();
    new AllExceptionsFilter().catch(
      new HttpException("Workflow is inactive", HttpStatus.CONFLICT),
      host({ method: "POST", url: "/hooks/x" }, res),
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ message: "Workflow is inactive" });
  });

  it("maps an unexpected error to a generic 500 (never leaks its message)", () => {
    const res = makeRes();
    // A Temporal-shaped error: a machine code + a message that must NOT reach the client.
    const err = Object.assign(
      new Error("connect ECONNREFUSED 10.0.0.1:7233 secret-dsn"),
      {
        code: "DEADLINE_EXCEEDED",
      },
    );
    new AllExceptionsFilter().catch(
      err,
      host({ method: "POST", url: "/hooks/x", id: "req-1" }, res),
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      statusCode: 500,
      message: "Internal server error",
    });
    // The client body carries neither the message nor the code.
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(res.body)).not.toContain("DEADLINE_EXCEEDED");
  });
});
