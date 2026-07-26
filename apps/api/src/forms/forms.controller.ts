import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { ApiOkResponse, ApiProduces } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";
import {
  FormDefinitionResponse,
  FormJsonSchemaResponse,
} from "./form.response";
import { ContentTemplatesService } from "../content-templates/content-templates.service";
import { ExecutionsService } from "../executions/executions.service";
import { GraphsService } from "../graphs/graphs.service";
import { TurnstileConfigService } from "../turnstile/turnstile-config.service";
import {
  extractFormDefinition,
  formTemplateId,
  validateSubmission,
} from "./form-definition";
import { buildFormJsonSchema } from "./form-schema";
import { FormAssetService } from "./form-asset.service";
import { FormService } from "./form.service";

/**
 * PUBLIC form ingress. Both routes are anonymous — the opaque `formId` is the only capability.
 *
 * Security posture (there is no secret to verify, unlike webhooks):
 *  - `GET` serves ONLY a public definition (no tenant/workflow ids ever leave the DB layer).
 *  - `POST` validates + strips the submission against the form's declared fields before it can
 *    become a workflow input, and re-resolves the graph so a form whose entry node was later
 *    changed away from `formTrigger` 404s (no injecting form input into a non-form graph).
 *  - A tight per-route `@Throttle` bounds abuse. NOTE: it's per-IP, so a distributed flood
 *    bypasses it — the REAL cost backstop is the tenant's monthly budget cap (required at
 *    registration; enforced per-LLM-call by the agent activity's atomic reservation).
 *  - No submission dedupe: a double-submit deliberately starts two runs (forms have no natural
 *    idempotency key; n8n behaves the same).
 */
@Public()
@Controller("forms")
export class FormsController {
  constructor(
    private readonly forms: FormService,
    private readonly graphs: GraphsService,
    private readonly executions: ExecutionsService,
    private readonly templates: ContentTemplatesService,
    private readonly turnstile: TurnstileConfigService,
    private readonly assets: FormAssetService,
  ) {}

  /**
   * Serve a hosted-page image (a form logo). ANONYMOUS, like the definition route — the page that
   * displays it is anonymous, so its images have to be too. The opaque asset id is the only
   * capability and nothing in the response identifies the owning tenant.
   *
   * Declared BEFORE `@Get(":formId")` so "assets" isn't captured as a form id.
   *
   * Response hardening, all of it load-bearing because these bytes are tenant-supplied and served from
   * OUR origin:
   *  - `nosniff` stops a browser from content-sniffing its way to `text/html` and executing the file.
   *  - `Content-Security-Policy: default-src 'none'; sandbox` neutralises anything scriptable that got
   *    past the magic-byte check — belt to the sniffer's braces, and what would make SVG safe later.
   *  - `Content-Disposition: inline` with no filename: the stored bytes have no author-controlled name
   *    to echo back into a header.
   *  - `immutable` caching is honest here BECAUSE ids are content-addressed: the same id can never
   *    return different bytes, since different bytes get a different id.
   */
  @Get("assets/:assetId")
  @ApiProduces("image/png", "image/jpeg", "image/gif", "image/webp")
  @ApiOkResponse({
    description:
      "The image bytes. Anonymous; the opaque asset id is the only capability. Cached immutably — " +
      "asset ids are content-addressed, so an id's bytes never change.",
  })
  async asset(
    @Param("assetId") assetId: string,
    @Res() res: Response,
  ): Promise<void> {
    const found = await this.assets.get(assetId);
    // 404 for an unknown id AND for a row whose object is missing — a broken logo must not 500 the
    // page it decorates.
    if (!found) throw new NotFoundException("Unknown asset");
    res.setHeader("content-type", found.contentType);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'none'; sandbox");
    res.setHeader("content-disposition", "inline");
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    // Content-addressed, so the hash IS the validator — a conditional request can be answered
    // without reading the object again.
    res.setHeader("etag", `"${found.sha256}"`);
    res.end(found.bytes);
  }

  /** Serve the public form definition (title/description/fields). 404 if the endpoint is unknown
   *  or its current graph's entry node isn't a formTrigger. Includes `turnstileSiteKey` when the
   *  tenant has an active Turnstile gate for this env (so the page renders the widget). */
  @Get(":formId")
  @ApiOkResponse({
    type: FormDefinitionResponse,
    description:
      "The public form definition: title/description/fields, the tenant's page branding, and the " +
      "Turnstile site key when this environment has an active bot gate. Carries no tenant or " +
      "workflow identifiers.",
  })
  async definition(@Param("formId") formId: string) {
    const { endpoint, def } = await this.resolve(formId);
    const turnstileSiteKey = await this.turnstile.publicSiteKey(
      endpoint.tenantId,
      endpoint.environmentId,
    );
    return turnstileSiteKey ? { ...def, turnstileSiteKey } : def;
  }

  /**
   * Serve a JSON Schema for this form's submission body — the contract for POSTing to the form
   * WITHOUT our hosted page (generate types from it, validate against it, then submit).
   *
   * The schema is sound, not complete: a payload it accepts is a payload `POST /forms/:formId`
   * accepts (see form-schema.ts for why the converse is deliberately not claimed). `botProtection`
   * is resolved here because it's an I/O lookup, and it matters — with the gate active the submit
   * route 403s before validating, so the schema must name `turnstileToken` rather than describe a
   * body that cannot succeed.
   *
   * Anonymous like the definition route: it reveals strictly less than `GET /forms/:formId`, which
   * already serves the same field list.
   */
  @Get(":formId/schema")
  @ApiOkResponse({
    type: FormJsonSchemaResponse,
    description:
      "A JSON Schema (draft 2020-12) for this form's submission body. Sound, not complete: a " +
      "payload it accepts is a payload POST /forms/{formId} accepts.",
  })
  async schema(@Param("formId") formId: string) {
    const { endpoint, def } = await this.resolve(formId);
    const siteKey = await this.turnstile.publicSiteKey(
      endpoint.tenantId,
      endpoint.environmentId,
    );
    return buildFormJsonSchema(formId, def.fields, {
      ...(def.title ? { title: def.title } : {}),
      ...(def.description ? { description: def.description } : {}),
      botProtection: siteKey != null,
    });
  }

  /** Accept an anonymous submission: verify the Turnstile challenge (if the tenant enabled it),
   *  validate + strip against the declared fields, then start the run with the sanitized data as the
   *  trigger output. 202 (fire-and-forget, like webhook ingress). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // 10 submissions / min / IP (per-IP; see class doc)
  @Post(":formId")
  @HttpCode(202)
  async submit(
    @Param("formId") formId: string,
    @Body() body: { turnstileToken?: unknown } & Record<string, unknown>,
  ) {
    const { endpoint, snapshot, def } = await this.resolve(formId);
    // Bot gate BEFORE validation/startForm — an unsolved challenge never spends the tenant's budget.
    const token =
      typeof body?.turnstileToken === "string"
        ? body.turnstileToken
        : undefined;
    const allowed = await this.turnstile.verify(
      endpoint.tenantId,
      endpoint.environmentId,
      token,
    );
    if (!allowed) {
      throw new ForbiddenException("Bot verification failed — please retry.");
    }
    // `turnstileToken` is not a declared field, so validateSubmission strips it (never reaches ctx).
    const result = validateSubmission(def.fields, body);
    if (!result.ok) throw new BadRequestException(result.error);
    await this.executions.startForm(
      endpoint.tenantId,
      endpoint.environmentId,
      snapshot,
      result.data,
      endpoint.workflowId,
    );
    // Deliberately do NOT return the workflowId: it's `form-<tenantId>-<uuid>`, which would hand
    // the tenantId to an anonymous caller (the opaque formId must stay the only capability). The
    // submitter can't query a run anyway (no auth), so an ack is all they need.
    return { status: "started" };
  }

  /** Shared resolution for both routes: endpoint → current graph snapshot → public definition.
   *  Throws 404 on any miss (unknown form, unseeded graph, or a graph whose entry isn't a form). */
  private async resolve(formId: string) {
    const endpoint = await this.forms.getEndpoint(formId);
    if (!endpoint) throw new NotFoundException("Unknown form");
    // Public trigger fires in the endpoint's OWN environment (design §Slice 4).
    const snapshot = await this.graphs.getLatest(
      endpoint.tenantId,
      endpoint.environmentId,
      endpoint.workflowId,
    );
    if (!snapshot) throw new NotFoundException("Unknown form");
    // Slice 4b: if the formTrigger references a form template, its `field` blocks source the form's
    // inputs. A deleted/missing/non-form template yields null → extractFormDefinition falls back to
    // the node's inline fields. Both routes resolve through here, so GET and POST see the same set.
    const templateId = formTemplateId(snapshot.graph);
    const templateBlocks = templateId
      ? await this.templates.loadFormBlocks(
          endpoint.tenantId,
          endpoint.environmentId,
          templateId,
        )
      : undefined;
    const def = extractFormDefinition(snapshot.graph, formId, templateBlocks);
    if (!def) throw new NotFoundException("Unknown form");
    return { endpoint, snapshot, def };
  }
}
