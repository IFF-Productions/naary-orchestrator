/**
 * Workflow-definition endpoints: templates, graphs CRUD, tags, pins + single-node
 * test, AI generate (JSON + SSE stream), error handler, versions/diff, promotion,
 * and the active toggle.
 */
import type { GraphDef, GraphDiff } from "@naary/dsl";
import { getBearerToken } from "../firebase-lazy";
import { createSseParser } from "../sse";
import {
  AccessNotAllowedError,
  BASE,
  getActiveEnvironment,
  getActiveWorkspace,
  http,
  UnauthorizedError,
} from "./http";
import type {
  DryRunResult,
  GraphSummary,
  GraphVersion,
  N8nImportResult,
  NamedGraph,
  Promotion,
  Tag,
  TagRef,
  TemplateDetail,
  TemplateSummary,
  TestNodeResult,
} from "./types";

export const graphsApi = {
  // Built-in workflow templates (global, not tenant-scoped).
  listTemplates(): Promise<TemplateSummary[]> {
    return http("/templates");
  },
  /**
   * Every template WITH its graph, in ONE request.
   *
   * The gallery needs all the graphs (it derives chains, categories, approval badges and
   * connection requirements from them). Fetching them per key was a 19-request fan-out
   * against a 120-req/min per-IP throttle, and any throttled request made that template
   * silently DISAPPEAR from the gallery — `Promise.allSettled` dropped it with no error.
   * One request removes the fan-out, the 429s, and the silent drop.
   */
  listTemplatesWithGraphs(): Promise<TemplateDetail[]> {
    return http("/templates?include=graph");
  },
  // A template + its graph — the canvas loads this as a new draft to fork.
  getTemplate(key: string): Promise<TemplateDetail> {
    return http(`/templates/${encodeURIComponent(key)}`);
  },
  // List the tenant's workflows (latest version per key).
  listGraphs(): Promise<GraphSummary[]> {
    return http("/graphs");
  },
  // --- Workflow tags (organizational metadata; tenant-wide per workflowKey) ---
  listTags(): Promise<Tag[]> {
    return http("/tags");
  },
  createTag(name: string, color?: string): Promise<Tag> {
    return http("/tags", {
      method: "POST",
      body: JSON.stringify({ name, ...(color ? { color } : {}) }),
    });
  },
  updateTag(
    tagId: string,
    patch: { name?: string; color?: string },
  ): Promise<TagRef> {
    return http(`/tags/${encodeURIComponent(tagId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
  deleteTag(tagId: string): Promise<{ deleted: true }> {
    return http(`/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" });
  },
  // REPLACE-SET: the workflow ends up with exactly these tag ids (empty clears all).
  setWorkflowTags(workflowKey: string, tagIds: string[]): Promise<TagRef[]> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tagIds }),
    });
  },
  // Fetch one workflow's latest graph (to open in the canvas).
  getGraph(workflowKey: string): Promise<NamedGraph> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}`);
  },
  // Delete a workflow (all versions) + its triggers/schedules. Run history is kept.
  deleteGraph(workflowKey: string): Promise<{ deleted: true }> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}`, {
      method: "DELETE",
    });
  },
  // Promote a workflow from the ACTIVE env (X-Environment-Id) into `toEnv` (copy-on-promote).
  promoteWorkflow(
    workflowKey: string,
    toEnv: string,
    fromVersion?: number,
  ): Promise<{ fromVersion: number; toVersion: number; contentHash: string }> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/promote`, {
      method: "POST",
      body: JSON.stringify({ toEnv, ...(fromVersion ? { fromVersion } : {}) }),
    });
  },
  listPromotions(workflowKey: string): Promise<Promotion[]> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/promotions`);
  },
  // --- Pinned node outputs (authoring-only samples; the interpreter never reads them) ---
  listPins(workflowKey: string): Promise<Record<string, unknown>> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/pins`);
  },
  pinNode(
    workflowKey: string,
    nodeId: string,
    output: unknown,
  ): Promise<{ pinned: true }> {
    return http(
      `/graphs/${encodeURIComponent(workflowKey)}/nodes/${encodeURIComponent(nodeId)}/pin`,
      { method: "PUT", body: JSON.stringify({ output }) },
    );
  },
  unpinNode(
    workflowKey: string,
    nodeId: string,
  ): Promise<{ cleared: boolean }> {
    return http(
      `/graphs/${encodeURIComponent(workflowKey)}/nodes/${encodeURIComponent(nodeId)}/pin`,
      { method: "DELETE" },
    );
  },
  // Single-node "Test": run one node against the workflow's pins (+ optional inputs override).
  // Pure nodes return { pure:true, output }; activity/control nodes return { pure:false, message }.
  testNode(
    workflowKey: string,
    nodeId: string,
    inputs?: Record<string, unknown>,
    autofillUpstream?: boolean,
  ): Promise<TestNodeResult> {
    return http(
      `/graphs/${encodeURIComponent(workflowKey)}/nodes/${encodeURIComponent(nodeId)}/test`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(inputs ? { inputs } : {}),
          ...(autofillUpstream ? { autofillUpstream: true } : {}),
        }),
      },
    );
  },
  // n8n import (#579): an n8n workflow export → an UNSAVED draft graph plus a per-node mapping
  // report (imported / approximated / unmapped-with-placeholder / skipped). Nothing is persisted;
  // save the draft with saveGraph. Credentials in the export are never imported — the response says
  // which connection types to create instead. `workflow` is the already-parsed JSON object.
  importN8nWorkflow(workflow: unknown): Promise<N8nImportResult> {
    return http("/graphs/import/n8n", {
      method: "POST",
      body: JSON.stringify({ workflow }),
    });
  },
  // AI workflow builder: describe a workflow → a validated DRAFT graph (unsaved).
  // `provider` (optional) picks the model provider; omitted ⇒ the server auto-selects
  // the tenant's first configured+valid one.
  // `previous` ⇒ edit that graph rather than invent one (see generateGraphStream). Against an
  // API old enough to predate the field this 400s naming `previous` — the ValidationPipe runs
  // forbidNonWhitelisted — rather than quietly dropping it and generating a replacement, which
  // is the failure this whole path exists to stop.
  generateGraph(
    prompt: string,
    provider?: string,
    previous?: GraphDef,
  ): Promise<{ name: string; graph: GraphDef }> {
    return http("/graphs/generate", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        ...(provider ? { provider } : {}),
        ...(previous ? { previous } : {}),
      }),
    });
  },
  // SSE variant of generateGraph: the server streams `: ping` heartbeats while the
  // model runs (so long generations survive the 60s proxy read timeout) and ends
  // with an `event: result` or `event: error` frame. Same resolved value/throws as
  // generateGraph; falls back to it against an older API without the route.
  //
  // `hooks` (optional) receive the LIVE frames the API-model path emits as it streams:
  // `onMeta(name)` once the workflow name is known, then `onNode`/`onEdge` per element as
  // each completes — so the canvas can draw the workflow incrementally. The resolved value
  // is always the authoritative validated graph (the `result` frame); reconcile to it. On
  // the 404/non-SSE fallback paths the hooks simply don't fire (the whole graph arrives at
  // once) — callers must handle that too.
  //
  // `previous` turns the call into an EDIT: `prompt` is then a change to apply to that graph
  // and the result is the whole updated graph. Without it the model invents a workflow from
  // scratch — which is what a "change this" request used to get.
  async generateGraphStream(
    prompt: string,
    provider?: string,
    hooks?: {
      onMeta?: (name: string) => void;
      onNode?: (node: unknown) => void;
      onEdge?: (edge: unknown) => void;
    },
    previous?: GraphDef,
  ): Promise<{ name: string; graph: GraphDef }> {
    const token = await getBearerToken();
    const activeWorkspaceId = getActiveWorkspace();
    const activeEnvironmentId = getActiveEnvironment();
    const res = await fetch(`${BASE}/graphs/generate/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : {}),
        ...(activeEnvironmentId
          ? { "x-environment-id": activeEnvironmentId }
          : {}),
      },
      body: JSON.stringify({
        prompt,
        ...(provider ? { provider } : {}),
        ...(previous ? { previous } : {}),
      }),
    });
    // Deploy skew: an older API has no /stream route → use the legacy JSON one.
    if (res.status === 404)
      return graphsApi.generateGraph(prompt, provider, previous);
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) {
      // Pre-stream failures (validation 400, guards 403) are plain JSON — mirror
      // http()'s mapping but surface the server message (CanvasPage shows it).
      const body = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string | string[];
      } | null;
      const message = Array.isArray(body?.message)
        ? body.message.join("; ")
        : body?.message;
      if (res.status === 403 && body?.code === "access_not_allowed") {
        throw new AccessNotAllowedError(message);
      }
      throw new Error(
        message ?? `POST /graphs/generate/stream → ${res.status}`,
      );
    }
    // Defensive skew tolerance: a proxy/server that answered JSON instead of SSE.
    if (
      !res.headers.get("content-type")?.includes("text/event-stream") ||
      !res.body
    ) {
      return res.json() as Promise<{ name: string; graph: GraphDef }>;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    for (;;) {
      const { done, value } = await reader.read();
      const frames = parser.push(
        done ? decoder.decode() : decoder.decode(value, { stream: true }),
      );
      for (const frame of frames) {
        if (frame.event === "meta") {
          try {
            const { name } = JSON.parse(frame.data) as { name?: string };
            if (name && hooks?.onMeta) hooks.onMeta(name);
          } catch {
            /* ignore a malformed meta frame — the result frame is authoritative */
          }
          continue;
        }
        if (frame.event === "node") {
          try {
            hooks?.onNode?.(JSON.parse(frame.data));
          } catch {
            /* ignore a half/garbled node frame; result reconciles */
          }
          continue;
        }
        if (frame.event === "edge") {
          try {
            hooks?.onEdge?.(JSON.parse(frame.data));
          } catch {
            /* ignore a half/garbled edge frame; result reconciles */
          }
          continue;
        }
        if (frame.event === "result") {
          return JSON.parse(frame.data) as { name: string; graph: GraphDef };
        }
        if (frame.event === "error") {
          const err = JSON.parse(frame.data) as {
            status: number;
            message?: string;
            code?: string;
          };
          if (err.status === 401) throw new UnauthorizedError();
          if (err.status === 403 && err.code === "access_not_allowed") {
            throw new AccessNotAllowedError(err.message);
          }
          throw new Error(err.message ?? "Couldn't generate a workflow.");
        }
      }
      if (done) break;
    }
    throw new Error("The generation stream ended unexpectedly. Try again.");
  },
  // The workflowKey of this workflow's error handler (null if none).
  getErrorHandler(
    workflowKey: string,
  ): Promise<{ errorWorkflowKey: string | null }> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/error-handler`);
  },
  // Bind (or clear, with null) this workflow's error handler.
  setErrorHandler(
    workflowKey: string,
    errorWorkflowKey: string | null,
  ): Promise<{ errorWorkflowKey: string | null }> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/error-handler`, {
      method: "PUT",
      body: JSON.stringify({ errorWorkflowKey }),
    });
  },
  // Save a compiled graph under a workflowKey (versioned + content-hashed server-side).
  saveGraph(
    workflowKey: string,
    name: string,
    graph: GraphDef,
  ): Promise<{ workflowKey: string; version: number; contentHash: string }> {
    return http("/graphs", {
      method: "POST",
      body: JSON.stringify({ workflowKey, name, graph }),
    });
  },
  // DRY RUN (#832): "will this flow run?" without running it. Validates every integration node's
  // config and request shape, then probes each DISTINCT connection with the provider's cheapest
  // read-only action. Executes no node. Note it checks the SAVED graph, which is why the canvas
  // saves first — otherwise the verdict would describe a version that isn't on screen.
  dryRunGraph(workflowKey: string): Promise<DryRunResult> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/dry-run`, {
      method: "POST",
    });
  },
  // Every stored version of a workflow (newest first) — powers the "re-run at version" picker.
  listGraphVersions(workflowKey: string): Promise<GraphVersion[]> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/versions`);
  },
  // Structural diff between two saved versions (nodes/edges added/removed/changed) — "review
  // what changed before promoting". The heavy lifting (diffGraphs) runs server-side; this returns
  // the structured GraphDiff plus the compared version numbers.
  diffGraphVersions(
    workflowKey: string,
    from: number,
    to: number,
  ): Promise<GraphDiff & { fromVersion: number; toVersion: number }> {
    return http(
      `/graphs/${encodeURIComponent(workflowKey)}/diff?from=${from}&to=${to}`,
    );
  },
  // Activate / deactivate a workflow (n8n parity): deactivating stops automatic triggers
  // (webhook/form refused, schedules paused). Manual runs still work.
  setWorkflowActive(
    tenantId: string,
    workflowKey: string,
    active: boolean,
  ): Promise<{ workflowKey: string; active: boolean }> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/workflows/${encodeURIComponent(workflowKey)}/active`,
      { method: "PUT", body: JSON.stringify({ active }) },
    );
  },
};
