import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
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
  constructor(private readonly forms: FormService) {}

  /** Register a form endpoint; returns the public path. 400 if the tenant has no budget cap. */
  @ApiEndpoint({
    summary: "Register a hosted form",
    description:
      "Returns the public form path. Requires a monthly budget cap (the anonymous endpoint's spend backstop).",
    created: RegisteredFormResponse,
  })
  @Post()
  register(
    @Param("id") tenantId: string,
    @Body() body: RegisterFormDto,
  ): Promise<RegisteredForm> {
    return this.forms.createEndpoint(tenantId, body.workflowId);
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
