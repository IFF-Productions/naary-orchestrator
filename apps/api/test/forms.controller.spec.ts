import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
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
  /** Turnstile: site key advertised on the definition (null = no gate). */
  siteKey?: string | null;
  /** An arbitrary bot gate (#782), e.g. `{ provider: "app_check" }`. Overrides `siteKey`. */
  gate?:
    | { provider: "turnstile"; siteKey: string }
    | { provider: "app_check" }
    | null;
  /** Turnstile: verify() verdict on submit (default allow). */
  verify?: boolean;
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
  // `publicGate` is the seam the controllers use (#782: App Check has no site key, so a bare string
  // couldn't express both providers). `opts.siteKey` still drives the Turnstile case so existing
  // cases read unchanged; `opts.gate` sets an arbitrary gate (e.g. `{ provider: "app_check" }`).
  const gate =
    opts.gate ??
    (opts.siteKey ? { provider: "turnstile", siteKey: opts.siteKey } : null);
  const turnstile = {
    publicGate: vi.fn().mockResolvedValue(gate),
    publicSiteKey: vi
      .fn()
      .mockResolvedValue(gate?.provider === "turnstile" ? gate.siteKey : null),
    verify: vi.fn().mockResolvedValue(opts.verify ?? true),
  };
  // FormAssetService — only the public asset-serving route uses it.
  const assets = { get: vi.fn().mockResolvedValue(null) };
  const controller = new FormsController(
    forms as never,
    graphs as never,
    executions as never,
    templates as never,
    turnstile as never,
    assets as never,
  );
  return {
    controller,
    forms,
    graphs,
    executions,
    templates,
    turnstile,
    assets,
  };
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

    it("advertises turnstileSiteKey when the tenant's bot gate is active", async () => {
      const withGate = await makeController({
        endpoint: ENDPOINT,
        siteKey: "0xSITEKEY",
      }).controller.definition("f-1");
      expect(withGate.turnstileSiteKey).toBe("0xSITEKEY");
      // Both shapes for a Turnstile gate: the new provider-neutral `botGate` AND the deprecated flat
      // key, because an embedded iframe may be running a cached bundle that only knows the old one.
      expect((withGate as { botGate?: unknown }).botGate).toEqual({
        provider: "turnstile",
        siteKey: "0xSITEKEY",
      });
      // …and omits both when no gate is configured.
      const noGate = await makeController({
        endpoint: ENDPOINT,
      }).controller.definition("f-1");
      expect(noGate).not.toHaveProperty("turnstileSiteKey");
      expect(noGate).not.toHaveProperty("botGate");
    });

    /** An App Check gate has NO site key, so the page has to learn about it from `botGate` alone. */
    it("advertises an app_check gate with no site key at all", async () => {
      const def = await makeController({
        endpoint: ENDPOINT,
        gate: { provider: "app_check" },
      }).controller.definition("f-1");
      expect((def as { botGate?: unknown }).botGate).toEqual({
        provider: "app_check",
      });
      expect(def).not.toHaveProperty("turnstileSiteKey");
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

    it("403s (no run) when the Turnstile challenge fails", async () => {
      const startForm = vi.fn();
      const { controller, turnstile } = makeController({
        endpoint: ENDPOINT,
        startForm,
        verify: false, // gate denies
      });
      await expect(
        controller.submit("f-1", { email: "a@b.com", turnstileToken: "bad" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // verified with the endpoint's (tenant, env) + the submitted token
      expect(turnstile.verify).toHaveBeenCalledWith("t-1", "e-1", "bad");
      expect(startForm).not.toHaveBeenCalled();
    });

    it("passes the gate, then strips turnstileToken from the data (never reaches the run)", async () => {
      const startForm = vi.fn().mockResolvedValue({ workflowId: "form-t-1-9" });
      const { controller } = makeController({
        endpoint: ENDPOINT,
        startForm,
        verify: true,
      });
      await controller.submit("f-1", {
        email: "a@b.com",
        turnstileToken: "good",
      });
      expect(startForm).toHaveBeenCalledWith(
        "t-1",
        "e-1",
        { graph: FORM_GRAPH },
        { email: "a@b.com" }, // turnstileToken stripped (not a declared field)
        "contact-form",
      );
    });
  });
});
