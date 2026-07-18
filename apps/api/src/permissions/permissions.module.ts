import { Global, Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { GroupsController } from "./groups.controller";
import { GroupsService } from "./groups.service";
import { MePermissionsController } from "./me-permissions.controller";
import { PermissionsCache } from "./permissions-cache";
import { PermissionsService } from "./permissions.service";

/**
 * Permission groups + grants + the effective-permissions resolver (RBAC-GROUPS.md, slice
 * G1). GLOBAL: the AuthGuard needs PermissionsService to stamp restricted `nry_` tokens
 * (§4a), and the workflow services (graphs/lifecycle/executions/pins/tags) assert through
 * it — a per-module import list would be most of the app.
 */
@Global()
@Module({
  controllers: [GroupsController, MePermissionsController],
  providers: [
    PermissionsService,
    GroupsService,
    { provide: PermissionsCache, useFactory: () => new PermissionsCache() },
  ],
  imports: [EnvironmentsModule],
  exports: [PermissionsService],
})
export class PermissionsModule {}
