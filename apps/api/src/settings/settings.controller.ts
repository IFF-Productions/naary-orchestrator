import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { SaveSettingsDto } from "./settings.dto";
import { type SettingsView, SettingsService } from "./settings.service";

/** tenantId from the path; AuthGuard enforces path-tenant == token-tenant. */
@Controller("tenants/:id/settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(@Param("id") tenantId: string): Promise<SettingsView> {
    return this.settings.get(tenantId);
  }

  @Put()
  save(
    @Param("id") tenantId: string,
    @Body() body: SaveSettingsDto,
  ): Promise<SettingsView> {
    return this.settings.save(tenantId, body);
  }
}
