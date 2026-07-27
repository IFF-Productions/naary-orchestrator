import { Module } from "@nestjs/common";
import { ConnectionService } from "@naary/connections";
import { EnvironmentsModule } from "../environments/environments.module";
import { AtlassianOAuthController } from "./atlassian-oauth.controller";
import { ConnectionTestService } from "./connection-test.service";
import { ConnectionsController } from "./connections.controller";
import { GithubAppController } from "./github-app.controller";
import { OAuthController } from "./oauth.controller";

@Module({
  imports: [EnvironmentsModule], // Connections/GithubApp controllers resolve the active env
  controllers: [
    ConnectionsController,
    OAuthController,
    GithubAppController,
    AtlassianOAuthController,
  ],
  // Plain class from @naary/connections; build once (reads ENCRYPTION_KEY at boot).
  providers: [
    { provide: ConnectionService, useFactory: () => new ConnectionService() },
    ConnectionTestService,
  ],
  // ConnectionTestService is exported for the DRY RUN (#832): checking a flow's credentials is the
  // same non-destructive probe as the Integrations "Test" button, and must not become a second
  // implementation that could drift into calling a write action.
  exports: [ConnectionService, ConnectionTestService],
})
export class ConnectionsModule {}
