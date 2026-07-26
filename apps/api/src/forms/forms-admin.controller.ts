import type { IncomingMessage } from "node:http";
import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiConsumes } from "@nestjs/swagger";
import { EnvironmentSel } from "../auth/tenant.decorator";
import { ACCEPTED_IMAGE_LABEL, MAX_ASSET_BYTES } from "./form-asset";
import { FormAssetService, readBodyCapped } from "./form-asset.service";
import { FormAssetResponse } from "./form.response";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  FormDeletedResponse,
  FormEndpointResponse,
  RegisteredFormResponse,
} from "./form.response";
import {
  type FormEndpointView,
  type RegisteredForm,
  FormService,
} from "./form.service";
import { RegisterFormDto } from "./register-form.dto";

/** Tenant-scoped management of hosted form endpoints (the public ingress is FormsController). */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/forms")
export class FormsAdminController {
  constructor(
    private readonly forms: FormService,
    private readonly environments: EnvironmentsService,
    private readonly assets: FormAssetService,
  ) {}

  /**
   * Upload a logo for this tenant's hosted form pages. The RAW image bytes are the request body, with
   * the file's content type as the header — no multipart, so no new dependency for one small file.
   *
   * The body is read with a hard byte cap in the handler rather than by a body parser:
   * `express.json()` is content-type gated and skips an `image/png` body entirely, and raising the
   * global JSON limit would loosen it for every endpoint including the anonymous form ingress (whose
   * tight cap is a documented protection).
   *
   * The `Content-Type` header is a CLAIM and is used for nothing — the stored type comes from the
   * file's magic bytes. Anyone can label an HTML document `image/png`, and these bytes are served back
   * from our own origin, so believing the header is the classic upload-to-XSS path. SVG is refused
   * outright (it's scriptable XML with no signature to sniff).
   *
   * Declared before `@Delete(":formId")`/`@Get(":formId")` siblings is unnecessary — different verb
   * and a literal segment — but the route stays grouped with the rest of the form admin surface.
   */
  @ApiEndpoint({
    summary: "Upload a hosted-form logo",
    description:
      `Raw image bytes as the body (${ACCEPTED_IMAGE_LABEL}, max ` +
      `${Math.floor(MAX_ASSET_BYTES / 1024)} KB). The file's magic bytes decide the stored type — ` +
      "the Content-Type header is ignored. SVG is not accepted. Re-uploading identical bytes returns " +
      "the existing asset id rather than creating a duplicate.",
    created: FormAssetResponse,
  })
  @ApiConsumes("image/png", "image/jpeg", "image/gif", "image/webp")
  @ApiBody({
    description: "The raw image bytes.",
    schema: { type: "string", format: "binary" },
  })
  @Post("assets")
  async uploadAsset(
    @Param("id") tenantId: string,
    @Req() req: IncomingMessage,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ assetId: string; contentType: string }> {
    // Assets are env-scoped like the endpoints and connections they sit beside: a sandbox logo is
    // never served by a prod form.
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    const bytes = await readBodyCapped(req);
    return this.assets.store(tenantId, envId, bytes);
  }

  /** Register a form endpoint; returns the public path. 400 if the tenant has no budget cap. */
  @ApiEndpoint({
    summary: "Register a hosted form",
    description:
      "Returns the public form path. Requires a monthly budget cap (the anonymous endpoint's spend backstop).",
    created: RegisteredFormResponse,
  })
  @Post()
  async register(
    @Param("id") tenantId: string,
    @Body() body: RegisterFormDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<RegisteredForm> {
    // Bind the endpoint to the registering user's ACTIVE env — the form fires runs there.
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.forms.createEndpoint(tenantId, envId, body.workflowId);
  }

  /** List the tenant's form endpoints. */
  @ApiEndpoint({
    summary: "List form endpoints",
    ok: [FormEndpointResponse],
  })
  @Get()
  list(@Param("id") tenantId: string): Promise<FormEndpointView[]> {
    return this.forms.list(tenantId);
  }

  /** Delete a form endpoint. Tenant-scoped; 404 if it isn't this tenant's. */
  @ApiEndpoint({
    summary: "Delete a form endpoint",
    description: "Tenant-scoped; 404 if it isn't this tenant's.",
    ok: FormDeletedResponse,
    notFound: true,
  })
  @Delete(":formId")
  async remove(
    @Param("id") tenantId: string,
    @Param("formId") formId: string,
  ): Promise<{ deleted: true }> {
    const ok = await this.forms.deleteEndpoint(tenantId, formId);
    if (!ok) throw new NotFoundException("Form endpoint not found");
    return { deleted: true };
  }
}
