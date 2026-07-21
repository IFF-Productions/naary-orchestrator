import "reflect-metadata";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import { describe, expect, it, vi } from "vitest";
import { SaveGraphDto } from "../src/graphs/graph.dto";
import { GraphsController } from "../src/graphs/graphs.controller";
import type { GraphGeneratorService } from "../src/graphs/graph-generator.service";
import type { GraphsService } from "../src/graphs/graphs.service";
import type { WorkflowLifecycleService } from "../src/graphs/workflow-lifecycle.service";

// Save/delete go through the consolidated WorkflowLifecycleService (upsert/delete + the
// default-env-only schedule side-effects, tested in workflow-lifecycle.service.spec).
// Routes that never save/delete get an empty stub.
const lifecycleStub = {} as unknown as WorkflowLifecycleService;

const envStub = {
  resolveEnvId: async () => "e1",
  defaultEnvId: async () => "e1",
  isDefaultEnv: async () => true,
} as never;

const validGraph: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "approval", type: "humanApproval" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "approval" },
    { from: "approval", to: "end" },
  ],
};

function dto(graph: unknown): SaveGraphDto {
  return Object.assign(new SaveGraphDto(), {
    workflowKey: "canvas",
    name: "Canvas draft",
    graph,
  });
}

describe("GraphsController", () => {
  it("saves a well-formed graph via the consolidated lifecycle path and returns the version + hash", async () => {
    const saveWorkflow = vi.fn().mockResolvedValue({
      graph: validGraph,
      version: 3,
      contentHash: "abc123",
    });
    const controller = new GraphsController(
      {} as unknown as GraphsService,
      {} as unknown as GraphGeneratorService,
      { saveWorkflow } as unknown as WorkflowLifecycleService,
      envStub,
    );

    const res = await controller.save("t-1", dto(validGraph));

    expect(res).toEqual({
      workflowKey: "canvas",
      version: 3,
      contentHash: "abc123",
    });
    // tenantId comes from the principal (arg 0), never the body. The trailing undefined
    // is the G1 actor param (no principal in this direct-call unit test).
    expect(saveWorkflow).toHaveBeenCalledWith(
      "t-1",
      "e1",
      "canvas",
      "Canvas draft",
      validGraph,
      undefined,
      undefined, // #488 message (none in this body)
    );
  });

  it("rejects a non-graph body with 400 (before touching the service)", async () => {
    const saveWorkflow = vi.fn();
    const controller = new GraphsController(
      {} as unknown as GraphsService,
      {} as unknown as GraphGeneratorService,
      { saveWorkflow } as unknown as WorkflowLifecycleService,
      envStub,
    );

    await expect(
      controller.save("t-1", dto({ not: "a graph" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saveWorkflow).not.toHaveBeenCalled();
  });

  it("deletes via the consolidated lifecycle path and 404s when nothing was deleted", async () => {
    const deleteWorkflow = vi.fn().mockResolvedValue(true);
    const controller = new GraphsController(
      {} as unknown as GraphsService,
      {} as unknown as GraphGeneratorService,
      { deleteWorkflow } as unknown as WorkflowLifecycleService,
      envStub,
    );

    expect(await controller.remove("t-1", "canvas")).toEqual({ deleted: true });
    expect(deleteWorkflow).toHaveBeenCalledWith(
      "t-1",
      "e1",
      "canvas",
      undefined,
    );

    deleteWorkflow.mockResolvedValue(false);
    await expect(controller.remove("t-1", "gone")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("lists the tenant's workflows", async () => {
    const summaries = [
      {
        workflowKey: "canvas",
        name: "Canvas draft",
        version: 2,
        updatedAt: "t",
      },
    ];
    const list = vi.fn().mockResolvedValue(summaries);
    const controller = new GraphsController(
      {
        list,
      } as unknown as GraphsService,
      {} as unknown as GraphGeneratorService,
      lifecycleStub,
      envStub,
    );

    expect(await controller.list("t-1")).toBe(summaries);
    expect(list).toHaveBeenCalledWith("t-1", "e1", undefined);
  });

  it("gets a single workflow's latest graph", async () => {
    const named = {
      workflowKey: "canvas",
      name: "Canvas draft",
      version: 2,
      graph: validGraph,
    };
    const getLatestNamed = vi.fn().mockResolvedValue(named);
    const controller = new GraphsController(
      {
        getLatestNamed,
      } as unknown as GraphsService,
      {} as unknown as GraphGeneratorService,
      lifecycleStub,
      envStub,
    );

    expect(await controller.get("t-1", "canvas")).toBe(named);
    expect(getLatestNamed).toHaveBeenCalledWith(
      "t-1",
      "e1",
      "canvas",
      undefined,
    );
  });

  it("404s when the workflowKey is unknown", async () => {
    const getLatestNamed = vi.fn().mockResolvedValue(null);
    const controller = new GraphsController(
      {
        getLatestNamed,
      } as unknown as GraphsService,
      {} as unknown as GraphGeneratorService,
      lifecycleStub,
      envStub,
    );

    await expect(controller.get("t-1", "nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// SSE generation route: heartbeats keep the proxy alive while the model runs;
// the stream always ends in a `result` or `error` frame (never a thrown 500 —
// headers are already sent). Raw ServerResponse is mocked by hand.
// ---------------------------------------------------------------------------
import type { ServerResponse } from "node:http";
import { UnprocessableEntityException } from "@nestjs/common";
import { GenerateGraphDto } from "../src/graphs/graph.dto";
import { afterEach, beforeEach } from "vitest";

function fakeRes() {
  const listeners: Record<string, () => void> = {};
  const res = {
    chunks: [] as string[],
    headers: undefined as unknown,
    statusCode: 0,
    writableEnded: false,
    destroyed: false,
    writeHead(status: number, headers: unknown) {
      res.statusCode = status;
      res.headers = headers;
      return res;
    },
    write(chunk: string) {
      res.chunks.push(chunk);
      return true;
    },
    end() {
      res.writableEnded = true;
    },
    on(event: string, fn: () => void) {
      listeners[event] = fn;
      return res;
    },
    emitClose() {
      res.destroyed = true;
      listeners["close"]?.();
    },
  };
  return res;
}

function genDto(prompt: string): GenerateGraphDto {
  return Object.assign(new GenerateGraphDto(), { prompt });
}

function streamController(generateStream: (...args: unknown[]) => unknown) {
  return new GraphsController(
    {} as unknown as GraphsService,
    { generateStream } as unknown as GraphGeneratorService,
    lifecycleStub,
    envStub,
  );
}

describe("GraphsController POST /graphs/generate/stream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes SSE headers + connected comment, passes the 300s ceiling, ends with a result frame", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ name: "Flow", graph: validGraph });
    const res = fakeRes();

    await streamController(generate).generateStream(
      "t-1",
      genDto("email me a digest"),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });
    expect(res.chunks[0]).toBe(": connected\n\n");
    expect(res.chunks[res.chunks.length - 1]).toBe(
      `event: result\ndata: ${JSON.stringify({ name: "Flow", graph: validGraph })}\n\n`,
    );
    expect(res.writableEnded).toBe(true);
    expect(generate).toHaveBeenCalledWith(
      "t-1",
      "e1",
      "email me a digest",
      undefined,
      // opts now also carries the live-frame hooks; assert the ceiling + that hooks exist.
      expect.objectContaining({
        timeoutMs: 300_000,
        onMeta: expect.any(Function),
        onNode: expect.any(Function),
        onEdge: expect.any(Function),
      }),
    );
  });

  it("emits meta/node/edge frames as the generator streams, then the result frame", async () => {
    // A generateStream that drives the hooks (as the streaming service would) before resolving.
    const generate = vi.fn().mockImplementation(
      async (
        _t: string,
        _e: string,
        _p: string,
        _prov: unknown,
        opts: {
          onMeta?: (n: string) => void;
          onNode?: (n: unknown) => void;
          onEdge?: (e: unknown) => void;
        },
      ) => {
        opts.onMeta?.("Flow");
        opts.onNode?.({ id: "start", type: "start" });
        opts.onNode?.({ id: "end", type: "end" });
        opts.onEdge?.({ from: "start", to: "end" });
        return { name: "Flow", graph: validGraph };
      },
    );
    const res = fakeRes();

    await streamController(generate).generateStream(
      "t-1",
      genDto("email me a digest"),
      res as unknown as ServerResponse,
    );

    // Frames arrive in order: connected, meta, node, node, edge, result.
    const events = res.chunks
      .filter((c) => c.startsWith("event:"))
      .map((c) => c.slice(0, c.indexOf("\n")));
    expect(events).toEqual([
      "event: meta",
      "event: node",
      "event: node",
      "event: edge",
      "event: result",
    ]);
    expect(res.chunks).toContain(
      `event: meta\ndata: ${JSON.stringify({ name: "Flow" })}\n\n`,
    );
    expect(res.chunks).toContain(
      `event: node\ndata: ${JSON.stringify({ id: "start", type: "start" })}\n\n`,
    );
    expect(res.chunks).toContain(
      `event: edge\ndata: ${JSON.stringify({ from: "start", to: "end" })}\n\n`,
    );
    expect(res.chunks[res.chunks.length - 1]).toBe(
      `event: result\ndata: ${JSON.stringify({ name: "Flow", graph: validGraph })}\n\n`,
    );
  });

  it("heartbeats every 15s while generating and stops after the terminal frame", async () => {
    let resolve!: (v: { name: string; graph: GraphDef }) => void;
    const generate = vi.fn().mockReturnValue(
      new Promise<{ name: string; graph: GraphDef }>((r) => {
        resolve = r;
      }),
    );
    const res = fakeRes();
    const done = streamController(generate).generateStream(
      "t-1",
      genDto("slow one"),
      res as unknown as ServerResponse,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(res.chunks.filter((c) => c === ": ping\n\n")).toHaveLength(2);

    resolve({ name: "Flow", graph: validGraph });
    await done;
    const after = res.chunks.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(res.chunks.length).toBe(after); // interval cleared
  });

  it("turns an HttpException into an error frame (status + message + code) instead of throwing", async () => {
    const generate = vi
      .fn()
      .mockRejectedValue(
        new UnprocessableEntityException("Couldn't generate a valid workflow."),
      );
    const res = fakeRes();

    await streamController(generate).generateStream(
      "t-1",
      genDto("bad"),
      res as unknown as ServerResponse,
    );

    const frame = res.chunks[res.chunks.length - 1];
    expect(frame.startsWith("event: error\ndata: ")).toBe(true);
    expect(JSON.parse(frame.slice("event: error\ndata: ".length))).toEqual({
      status: 422,
      message: "Couldn't generate a valid workflow.",
    });
    expect(res.writableEnded).toBe(true);
  });

  it("sanitizes a non-HttpException to a generic 500 frame (no internals leaked)", async () => {
    const generate = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED db.internal:5432"));
    const res = fakeRes();

    await streamController(generate).generateStream(
      "t-1",
      genDto("boom"),
      res as unknown as ServerResponse,
    );

    const frame = res.chunks[res.chunks.length - 1];
    const body = JSON.parse(frame.slice("event: error\ndata: ".length));
    expect(body.status).toBe(500);
    expect(body.message).not.toContain("ECONNREFUSED");
    expect(res.writableEnded).toBe(true);
  });

  it("suppresses writes after the client disconnects mid-generation", async () => {
    let resolve!: (v: { name: string; graph: GraphDef }) => void;
    const generate = vi.fn().mockReturnValue(
      new Promise<{ name: string; graph: GraphDef }>((r) => {
        resolve = r;
      }),
    );
    const res = fakeRes();
    const done = streamController(generate).generateStream(
      "t-1",
      genDto("abandoned"),
      res as unknown as ServerResponse,
    );

    res.emitClose();
    await vi.advanceTimersByTimeAsync(45_000);
    resolve({ name: "Flow", graph: validGraph });
    await done;

    expect(res.chunks.filter((c) => c === ": ping\n\n")).toHaveLength(0);
    expect(res.chunks.some((c) => c.startsWith("event: result"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error-handler binding routes are ENV-scoped (slice-6 cleanup): both resolve
// the X-Environment-Id selector and pass the RESOLVED env id to the service.
// ---------------------------------------------------------------------------
describe("GraphsController error-handler env scoping", () => {
  function make() {
    const graphs = {
      getErrorHandler: vi.fn().mockResolvedValue("on-error"),
      setErrorHandler: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new GraphsController(
      graphs as unknown as GraphsService,
      {} as unknown as GraphGeneratorService,
      lifecycleStub,
      envStub,
    );
    return { controller, graphs };
  }

  it("GET resolves the env selector and reads that env's binding", async () => {
    const { controller, graphs } = make();
    const res = await controller.getErrorHandler("t-1", "wf", "sandbox");
    expect(res).toEqual({ errorWorkflowKey: "on-error" });
    // envStub resolves every selector to "e1".
    expect(graphs.getErrorHandler).toHaveBeenCalledWith(
      "t-1",
      "e1",
      "wf",
      undefined,
    );
  });

  it("PUT binds in the resolved env (absent selector = tenant default)", async () => {
    const { controller, graphs } = make();
    await controller.setErrorHandler(
      "t-1",
      "wf",
      { errorWorkflowKey: "on-error" },
      undefined,
    );
    expect(graphs.setErrorHandler).toHaveBeenCalledWith(
      "t-1",
      "e1",
      "wf",
      "on-error",
      undefined,
    );
  });
});
