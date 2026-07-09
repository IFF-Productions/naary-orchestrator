import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";
import { ExecutionsService } from "../executions/executions.service";
import { GraphsService } from "../graphs/graphs.service";
import { extractFormDefinition, validateSubmission } from "./form-definition";
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
  ) {}

  /** Serve the public form definition (title/description/fields). 404 if the endpoint is unknown
   *  or its current graph's entry node isn't a formTrigger. */
  @Get(":formId")
  async definition(@Param("formId") formId: string) {
    const { def } = await this.resolve(formId);
    return def;
  }

  /** Accept an anonymous submission: validate against the declared fields, then start the run
   *  with the sanitized data as the trigger output. 202 (fire-and-forget, like webhook ingress). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // 10 submissions / min / IP (per-IP; see class doc)
  @Post(":formId")
  @HttpCode(202)
  async submit(@Param("formId") formId: string, @Body() body: unknown) {
    const { endpoint, snapshot, def } = await this.resolve(formId);
    const result = validateSubmission(def.fields, body);
    if (!result.ok) throw new BadRequestException(result.error);
    await this.executions.startForm(
      endpoint.tenantId,
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
    const snapshot = await this.graphs.getLatest(
      endpoint.tenantId,
      endpoint.workflowId,
    );
    if (!snapshot) throw new NotFoundException("Unknown form");
    const def = extractFormDefinition(snapshot.graph, formId);
    if (!def) throw new NotFoundException("Unknown form");
    return { endpoint, snapshot, def };
  }
}
