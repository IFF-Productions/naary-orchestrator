import { beforeEach, describe, expect, it, vi } from "vitest";
import { HooksController } from "../src/webhooks/hooks.controller";

const endpoint = { tenantId: "t-1", provider: "github", workflowId: "wk" };

function makeDeps(graphNodes: { type: string }[]) {
  const webhooks = {
    getEndpoint: vi.fn().mockResolvedValue(endpoint),
    verifySignature: vi.fn().mockReturnValue(true),
    decryptSigningSecret: vi.fn().mockReturnValue("secret"),
    deliveryHeaderFor: vi.fn().mockReturnValue("x-github-delivery"),
    isDuplicateDelivery: vi.fn().mockResolvedValue(false),
    removeDelivery: vi.fn().mockResolvedValue(undefined),
  };
  const executions = {
    startWebhook: vi.fn().mockResolvedValue({ workflowId: "wf-plain" }),
    startWebhookAwaitResponse: vi.fn(),
  };
  const graphs = {
    getLatest: vi
      .fn()
      .mockResolvedValue({ graph: { nodes: graphNodes, edges: [] } }),
  };
  const res = { status: vi.fn(), set: vi.fn() };
  const req = { rawBody: Buffer.from("{}") };
  // a present signature header (verifySignature is mocked to accept it)
  const headers = { "x-hub-signature-256": "sha256=deadbeef" };
  const controller = new HooksController(
    webhooks as never,
    executions as never,
    graphs as never,
    { defaultEnvId: async () => "e1", resolveEnvId: async () => "e1" } as never,
  );
  return { controller, webhooks, executions, graphs, res, req, headers };
}

describe("HooksController.ingress", () => {
  beforeEach(() => vi.clearAllMocks());

  it("S-4: an unsigned request is rejected BEFORE any DB read/decrypt", async () => {
    const { controller, webhooks, req, res } = makeDeps([
      { type: "webhookTrigger" },
    ]);
    await expect(
      controller.ingress("ep-1", req as never, {}, {}, res as never), // no signature header
    ).rejects.toMatchObject({ status: 401 });
    expect(webhooks.getEndpoint).not.toHaveBeenCalled();
    expect(webhooks.decryptSigningSecret).not.toHaveBeenCalled();
  });

  it("respondToWebhook graph → returns the node's response with its status + headers", async () => {
    const { controller, executions, res, req, headers } = makeDeps([
      { type: "webhookTrigger" },
      { type: "respondToWebhook" },
    ]);
    executions.startWebhookAwaitResponse.mockResolvedValue({
      workflowId: "wf-1",
      response: {
        statusCode: 201,
        body: { ok: true },
        headers: { "x-trace": "1" },
      },
    });

    const body = await controller.ingress(
      "ep-1",
      req as never,
      {},
      headers,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.set).toHaveBeenCalledWith({ "x-trace": "1" });
    expect(body).toEqual({ ok: true });
    expect(executions.startWebhook).not.toHaveBeenCalled();
  });

  it("respondToWebhook graph that never responds → falls back to 202 started", async () => {
    const { controller, executions, res, req, headers } = makeDeps([
      { type: "respondToWebhook" },
    ]);
    executions.startWebhookAwaitResponse.mockResolvedValue({
      workflowId: "wf-2",
    });

    const body = await controller.ingress(
      "ep-1",
      req as never,
      {},
      headers,
      res as never,
    );
    expect(res.status).not.toHaveBeenCalled(); // @HttpCode(202) applies
    expect(body).toEqual({ status: "started", workflowId: "wf-2" });
  });

  it("no respondToWebhook node → fire-and-forget 202 (never awaits a response)", async () => {
    const { controller, executions, res, req, headers } = makeDeps([
      { type: "agent" },
      { type: "end" },
    ]);
    const body = await controller.ingress(
      "ep-1",
      req as never,
      {},
      headers,
      res as never,
    );
    expect(executions.startWebhookAwaitResponse).not.toHaveBeenCalled();
    expect(executions.startWebhook).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(body).toEqual({ status: "started", workflowId: "wf-plain" });
  });

  const deliv = { "x-github-delivery": "d-1" };

  it("duplicate delivery → duplicate_ignored, never starts a run", async () => {
    const { controller, webhooks, executions, req, res, headers } = makeDeps([
      { type: "webhookTrigger" },
    ]);
    webhooks.isDuplicateDelivery.mockResolvedValue(true);
    const body = await controller.ingress(
      "ep-1",
      req as never,
      {},
      { ...headers, ...deliv },
      res as never,
    );
    expect(body).toEqual({ status: "duplicate_ignored" });
    expect(executions.startWebhook).not.toHaveBeenCalled();
  });

  it("no graph seeded → 404 and the delivery is NOT recorded (retry can start once seeded)", async () => {
    const { controller, webhooks, graphs, req, res, headers } = makeDeps([]);
    graphs.getLatest.mockResolvedValue(null);
    await expect(
      controller.ingress(
        "ep-1",
        req as never,
        {},
        { ...headers, ...deliv },
        res as never,
      ),
    ).rejects.toMatchObject({ status: 404 });
    // The dedupe store is only touched once we've committed to processing.
    expect(webhooks.isDuplicateDelivery).not.toHaveBeenCalled();
    expect(webhooks.removeDelivery).not.toHaveBeenCalled();
  });

  it("start throws (e.g. inactive workflow) → rolls back the dedupe record and rethrows", async () => {
    const { controller, webhooks, executions, req, res, headers } = makeDeps([
      { type: "webhookTrigger" },
    ]);
    executions.startWebhook.mockRejectedValue(new Error("workflow inactive"));
    await expect(
      controller.ingress(
        "ep-1",
        req as never,
        {},
        { ...headers, ...deliv },
        res as never,
      ),
    ).rejects.toThrow("workflow inactive");
    // The recorded delivery is un-burned so the provider's retry isn't swallowed.
    expect(webhooks.removeDelivery).toHaveBeenCalledWith("ep-1", "d-1");
  });

  it("start succeeds → the dedupe record is KEPT (not rolled back)", async () => {
    const { controller, webhooks, req, res, headers } = makeDeps([
      { type: "agent" },
    ]);
    await controller.ingress(
      "ep-1",
      req as never,
      {},
      { ...headers, ...deliv },
      res as never,
    );
    expect(webhooks.isDuplicateDelivery).toHaveBeenCalledWith("ep-1", "d-1");
    expect(webhooks.removeDelivery).not.toHaveBeenCalled();
  });
});
