import { type Server, createServer } from "node:http";
import { type AddressInfo } from "node:net";
import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_QUEUE, stateQuery } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { MemoryObjectStore, __setObjectStore } from "@naary/storage";
import * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";

/**
 * REAL flow integration for the httpRequest + graphQL NODES: they run through the real Temporal
 * interpreter and the real activities against a REAL in-process HTTP server (a genuine network
 * round-trip over 127.0.0.1) — no mocked fetch. The server answers a REST route and a
 * GraphQL-over-HTTP endpoint.
 *
 * Two seams are relaxed to reach a local server (everything else — real activity, real fetch, real
 * request/response parsing — is untouched):
 *  - __httpDeps.assertEgressAllowed → returns the URL unchecked (the SSRF https+public guard rightly
 *    blocks 127.0.0.1 in prod; it's unit-tested in http.activity.spec — here we prove the call PATH).
 *  - __httpDeps.fetch → the global fetch (safeFetch's guarded dispatcher blocks private IPs at the
 *    transport layer, which would also reject the local server).
 *
 * The GraphQL endpoint is a faithful GraphQL-OVER-HTTP responder (parses {query,variables}, returns
 * {data}/{errors} with a 200), not a full execution engine — enough to prove the node forwards
 * variables and surfaces data + the 200-with-errors case the way real servers do.
 *
 * Docker-free (no testcontainers) but grouped with the integration suite; run `pnpm test:integration`.
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

let env: TestWorkflowEnvironment;
let server: Server;
let baseUrl: string;

/** Read a request body to a string (small test payloads only). */
function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const json = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && req.url === "/ping") {
        return json(200, { pong: true, ua: req.headers["x-test"] ?? null });
      }
      if (req.method === "POST" && req.url === "/echo") {
        const body = await readBody(req);
        return json(201, { received: JSON.parse(body || "{}") });
      }
      if (req.method === "POST" && req.url === "/graphql") {
        const { query, variables } = JSON.parse((await readBody(req)) || "{}");
        // Faithful GraphQL-over-HTTP: a query containing "boom" yields a 200-with-errors
        // response; otherwise echo the variables back under `data` (200).
        if (typeof query === "string" && query.includes("boom")) {
          return json(200, {
            data: null,
            errors: [{ message: "boom happened" }],
          });
        }
        return json(200, { data: { echoedVariables: variables ?? null } });
      }
      json(404, { error: "not found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  env = await TestWorkflowEnvironment.createLocal();
  __setObjectStore(new MemoryObjectStore());

  // Reach the local server: bypass the https/public pre-check and the private-IP transport guard.
  activities.__httpDeps.assertEgressAllowed = (async (u: string) =>
    new URL(u)) as never;
  activities.__httpDeps.fetch = ((url: string | URL, init?: RequestInit) =>
    globalThis.fetch(String(url), init as RequestInit)) as never;
}, 120_000);

afterAll(async () => {
  await env?.teardown();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

function makeWorker(): Promise<Worker> {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: {
      ...activities,
      recordExecution: async () => undefined,
      setExecutionStatus: async () => undefined,
      loadVariables: async () => ({}),
    },
  });
}

describe("httpRequest node — real flow against a real HTTP server", () => {
  it("GETs a JSON endpoint and exposes the real status + body to later steps", async () => {
    const graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "h",
          type: "httpRequest",
          config: {
            method: "GET",
            url: `${baseUrl}/ping`,
            headers: { "x-test": "hello" },
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "h" },
        { from: "h", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-http-int" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-http-integration",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      const out = final.ctx.h as {
        status: number;
        body: { pong: boolean; ua: string };
      };
      expect(out.status).toBe(200);
      expect(out.body.pong).toBe(true);
      // header actually reached the server and came back through the real round-trip
      expect(out.body.ua).toBe("hello");
    });
  });

  it("POSTs a JSON body and gets the server's real 201 + echoed body", async () => {
    const graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "h",
          type: "httpRequest",
          config: {
            method: "POST",
            url: `${baseUrl}/echo`,
            body: { name: "ada", n: 42 },
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "h" },
        { from: "h", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-http-int" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-http-post-integration",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      const out = final.ctx.h as {
        status: number;
        body: { received: unknown };
      };
      expect(out.status).toBe(201);
      expect(out.body.received).toEqual({ name: "ada", n: 42 });
    });
  });
});

describe("graphQL node — real flow against a real GraphQL-over-HTTP endpoint", () => {
  it("POSTs a query with variables and exposes the real data to later steps", async () => {
    const graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "g",
          type: "graphQL",
          config: {
            url: `${baseUrl}/graphql`,
            query: "query($id: ID!) { user(id: $id) { name } }",
            variables: { id: "u-7" },
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "g" },
        { from: "g", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-gql-int" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-graphql-integration",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      const out = final.ctx.g as {
        httpStatus: number;
        data: { echoedVariables: unknown };
        errors: unknown;
      };
      expect(out.httpStatus).toBe(200);
      // the node forwarded the variables to the server, which echoed them under data
      expect(out.data.echoedVariables).toEqual({ id: "u-7" });
      expect(out.errors).toBeNull();
    });
  });

  it("surfaces a 200-with-errors GraphQL response as first-class errors", async () => {
    const graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "g",
          type: "graphQL",
          config: {
            url: `${baseUrl}/graphql`,
            // triggers the server's error branch
            query: "query { boom }",
            // failOnErrors omitted → the node returns errors instead of throwing, so edges can branch
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "g" },
        { from: "g", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-gql-int" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-graphql-errors-integration",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      const out = final.ctx.g as {
        httpStatus: number;
        data: unknown;
        errors: { message: string }[];
      };
      expect(out.httpStatus).toBe(200);
      expect(out.errors).toEqual([{ message: "boom happened" }]);
    });
  });
});
