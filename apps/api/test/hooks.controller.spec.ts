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
  );
  return { controller, webhooks, executions, res, req, headers };
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
});
