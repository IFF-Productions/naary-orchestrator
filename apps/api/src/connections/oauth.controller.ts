import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import {
  ConnectionService,
  completeConsent,
  startConsent,
} from "@naary/connections";
import { Public } from "../auth/public.decorator";

/**
 * Interactive OAuth consent (B3) — runs once in the web app. `start` returns the
 * authorize URL for the browser; the provider redirects back to `callback`, which
 * exchanges the code and persists the encrypted refresh token. The activity then
 * refreshes non-interactively (B4). Browser consent is deferred-live this slice.
 */
@Controller()
export class OAuthController {
  constructor(private readonly connections: ConnectionService) {}

  @Post("tenants/:id/connections/:connectionId/oauth/start")
  async start(
    @Param("id") tenantId: string,
    @Param("connectionId") connectionId: string,
  ): Promise<{ authorizeUrl: string }> {
    const conn = await this.connections.getById(tenantId, connectionId);
    if (!conn) throw new NotFoundException("Unknown connection");
    const redirectUri =
      process.env.OAUTH_REDIRECT_URI ??
      `http://localhost:${process.env.PORT ?? 3000}/oauth/callback`;
    return startConsent({
      tenantId,
      connectionId,
      serverUrl: conn.serverUrl,
      redirectUri,
    });
  }

  @Public() // provider redirect target; the single-use `state` is its credential
  @Get("oauth/callback")
  callback(
    @Query("state") state: string,
    @Query("code") code: string,
    @Query("iss") iss?: string,
  ): Promise<{ connectionId: string }> {
    return completeConsent({ state, code, iss });
  }
}
