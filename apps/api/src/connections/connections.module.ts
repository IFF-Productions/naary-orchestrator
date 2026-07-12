import { Module } from "@nestjs/common";
import { ConnectionService } from "@naary/connections";
import { ConnectionsController } from "./connections.controller";
import { GithubAppController } from "./github-app.controller";
import { OAuthController } from "./oauth.controller";

@Module({
  controllers: [ConnectionsController, OAuthController, GithubAppController],
  // Plain class from @naary/connections; build once (reads ENCRYPTION_KEY at boot).
  providers: [
    { provide: ConnectionService, useFactory: () => new ConnectionService() },
  ],
  exports: [ConnectionService],
})
export class ConnectionsModule {}
