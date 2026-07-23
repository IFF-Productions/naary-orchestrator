import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import { FormsController } from "../src/forms/forms.controller";

const FORM_GRAPH: GraphDef = {
  startNodeId: "form",
  nodes: [
    {
      id: "form",
      type: "formTrigger",
      config: {
        title: "Contact",
        fields: [
          { key: "email", label: "Email", type: "email", required: true },
        ],
      } as never,
    },
    { id: "end", type: "end" },
  ],
  edges: [{ from: "form", to: "end" }],
};

function makeController(opts: {
  endpoint?: unknown;
  graph?: GraphDef | null;
  startForm?: ReturnType<typeof vi.fn>;
  /** Template blocks returned by loadFormBlocks (null = deleted/missing → inline fallback). */
  templateBlocks?: unknown[] | null;
}) {
  const forms = { getEndpoint: vi.fn().mockResolvedValue(opts.endpoint) };
  const graphs = {
    getLatest: vi
      .fn()
      .mockResolvedValue(
        opts.graph === null ? null : { graph: opts.graph ?? FORM_GRAPH },
      ),
  };
  const executions = {
    startForm:
      opts.startForm ?? vi.fn().mockResolvedValue({ workflowId: "form-1" }),
  };
  const templates = {
    loadFormBlocks: vi.fn().mockResolvedValue(opts.templateBlocks ?? null),
  };
  const controller = new FormsController(
    forms as never,
    graphs as never,
    executions as never,
    templates as never,
  );
  return { controller, forms, graphs, executions, templates };
}

const ENDPOINT = {
  id: "f-1",
  tenantId: "t-1",
  environmentId: "e-1",
  workflowId: "contact-form",
};

describe("FormsController (public)", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET definition", () => {
    it("serves the public definition WITHOUT any tenant/workflow identifiers", async () => {
      const { controller } = makeController({ endpoint: ENDPOINT });
      const def = await controller.definition("f-1");
      const serialized = JSON.stringify(def);
      expect(serialized).not.toContain("t-1");
      expect(serialized).not.toContain("contact-form");
      expect(def).toEqual({
        formId: "f-1",
        title: "Contact",
        fields: [
          { key: "email", label: "Email", type: "email", required: true },
        ],
      });
    });

    it("404s on an unknown form", async () => {
      const { controller } = makeController({ endpoint: null });
      await expect(controller.definition("nope")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("404s when the graph's entry node isn't a formTrigger", async () => {
      const wh: GraphDef = {
        startNodeId: "wh",
        nodes: [{ id: "wh", type: "webhookTrigger" }],
        edges: [],
      };
      const { controller } = makeController({ endpoint: ENDPOINT, graph: wh });
      await expect(controller.definition("f-1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("sources fields from the referenced template, scoped to the endpoint's (tenant, env)", async () => {
      const graph: GraphDef = {
        startNodeId: "form",
        nodes: [
          {
            id: "form",
            type: "formTrigger",
            config: {
              title: "Contact",
              templateId: "tpl-1",
              fields: [{ key: "inline", label: "Inline", type: "text" }],
            } as never,
          },
        ],
        edges: [],
      };
      const { controller, templates } = makeController({
        endpoint: ENDPOINT,
        graph,
        templateBlocks: [
          {
            id: "b1",
            type: "field",
            key: "email",
            label: "Email",
            fieldType: "email",
            required: true,
          },
        ],
      });
      const def = await controller.definition("f-1");
      // Template-derived fields REPLACE the inline ones.
      expect(def.fields).toEqual([
        { key: "email", label: "Email", type: "email", required: true },
      ]);
      expect(templates.loadFormBlocks).toHaveBeenCalledWith(
        "t-1",
        "e-1",
        "tpl-1",
      );
    });

    it("falls back to inline fields when the referenced template is deleted (null blocks)", async () => {
      const graph: GraphDef = {
        startNodeId: "form",
        nodes: [
          {
            id: "form",
            type: "formTrigger",
            config: {
              templateId: "gone",
              fields: [{ key: "email", label: "Email", type: "email" }],
            } as never,
          },
        ],
        edges: [],
      };
      const { controller } = makeController({
        endpoint: ENDPOINT,
        graph,
        templateBlocks: null,
      });
      const def = await controller.definition("f-1");
      expect(def.fields).toEqual([
        { key: "email", label: "Email", type: "email" },
      ]);
    });
  });

  describe("POST submit", () => {
    it("validates then starts the run with the sanitized data + ack (NO workflowId leaked)", async () => {
      const startForm = vi.fn().mockResolvedValue({ workflowId: "form-t-1-9" });
      const { controller, executions } = makeController({
        endpoint: ENDPOINT,
        startForm,
      });
      const out = await controller.submit("f-1", {
        email: "a@b.com",
        junk: "x",
      });
      // ack only — the workflowId embeds the tenantId and must not reach an anonymous caller
      expect(out).toEqual({ status: "started" });
      expect(JSON.stringify(out)).not.toContain("t-1");
      // started with the RESOLVED snapshot, tenant + workflowKey, and SANITIZED data (junk stripped)
      expect(startForm).toHaveBeenCalledWith(
        "t-1",
        "e-1",
        { graph: FORM_GRAPH },
        { email: "a@b.com" },
        "contact-form",
      );
      expect(executions.startForm).toHaveBeenCalledOnce();
    });

    it("400s on an invalid submission and never starts a run", async () => {
      const startForm = vi.fn();
      const { controller } = makeController({ endpoint: ENDPOINT, startForm });
      await expect(controller.submit("f-1", {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(startForm).not.toHaveBeenCalled();
    });

    it("404s (no run) when the endpoint is unknown", async () => {
      const startForm = vi.fn();
      const { controller } = makeController({ endpoint: null, startForm });
      await expect(controller.submit("nope", {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(startForm).not.toHaveBeenCalled();
    });
  });
});
