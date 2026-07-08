import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { UserScoped } from "../auth/user-scoped.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { SavePreferencesDto } from "./preferences.dto";
import { PreferencesResponse } from "./preferences.response";
import { type PreferenceView, PreferencesService } from "./preferences.service";

/**
 * Per-user preferences under `/me` — identity-scoped, NOT workspace-scoped (`@UserScoped`),
 * so a user with no active workspace still reads/writes them and they follow the user across
 * devices. Keyed by the Firebase uid from the principal; API-token principals (no uid) get a
 * graceful `{ mode: null }` and keep their client-side localStorage.
 */
@ApiBearerAuth("bearer")
@Controller("me/preferences")
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @ApiEndpoint({ summary: "Get my preferences", ok: PreferencesResponse })
  @Get()
  @UserScoped()
  get(@CurrentPrincipal() principal: Principal): Promise<PreferenceView> {
    return this.preferences.get(principal.userId);
  }

  @ApiEndpoint({ summary: "Update my preferences", ok: PreferencesResponse })
  @Put()
  @UserScoped()
  save(
    @CurrentPrincipal() principal: Principal,
    @Body() body: SavePreferencesDto,
  ): Promise<PreferenceView> {
    return this.preferences.save(principal.userId, body.mode ?? null);
  }
}
