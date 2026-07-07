import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ApiEndpoint } from "../swagger/api-decorators";
import { SaveSettingsDto } from "./settings.dto";
import { SettingsResponse } from "./settings.response";
import { type SettingsView, SettingsService } from "./settings.service";

/** tenantId from the path; AuthGuard enforces path-tenant == token-tenant. */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @ApiEndpoint({ summary: "Get tenant settings", ok: SettingsResponse })
  @Get()
  get(@Param("id") tenantId: string): Promise<SettingsView> {
    return this.settings.get(tenantId);
  }

  @ApiEndpoint({ summary: "Update tenant settings", ok: SettingsResponse })
  @Put()
  save(
    @Param("id") tenantId: string,
    @Body() body: SaveSettingsDto,
  ): Promise<SettingsView> {
    return this.settings.save(tenantId, body);
  }
}
