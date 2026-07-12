import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation } from "@nestjs/swagger";
import {
  completeGithubAppInstall,
  startGithubAppInstall,
} from "@naary/connections";
import { Public } from "../auth/public.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  GithubAppInstallStartResponse,
  OAuthCallbackResponse,
} from "./connection.response";
import { GithubAppInstallStartDto } from "./github-app-install.dto";

/**
 * GitHub App connect flow (docs/design/APP-AUTH.md §3a). INVERTED vs OAuth: GitHub gives no
 * installation id until AFTER the user installs, so `start` only persists a CSRF state (carrying
 * the tenant + label) and returns the github.com install URL; the CALLBACK creates the
 * github_app connection from the returned `installation_id`. UI + save-time "test" are Slice 4.
 *
 * NOTE: unverified against a live app — GitHub's echo of `state` on the plain install redirect
 * needs live confirmation; the callback fails closed if `state`/`installation_id` are absent.
 */
@Controller()
export class GithubAppController {
  @ApiBearerAuth("bearer")
  @ApiEndpoint({
    summary: "Start GitHub App install",
    description:
      "Returns the github.com install URL for the browser; the user picks repos, then GitHub redirects to the callback.",
    ok: GithubAppInstallStartResponse,
  })
  @Post("tenants/:id/connections/github-app/install/start")
  async start(
    @Param("id") tenantId: string,
    @Body() body: GithubAppInstallStartDto,
  ): Promise<{ installUrl: string }> {
    // Return ONLY installUrl — the `state` is a single-use CSRF credential already embedded in
    // installUrl; surfacing it as a separate field would leak it out-of-band and diverge from
    // the Swagger contract (GithubAppInstallStartResponse has just installUrl).
    const { installUrl } = await startGithubAppInstall({
      tenantId,
      label: body.label?.trim() || "GitHub",
    });
    return { installUrl };
  }

  @ApiOperation({
    summary: "GitHub App install callback (provider redirect target)",
    description:
      "Public: GitHub redirects here with `installation_id`, `setup_action`, and the single-use `state` (its credential); creates the github_app connection and stores the installation grant.",
  })
  @ApiOkResponse({ type: OAuthCallbackResponse })
  @Public() // provider redirect target; the single-use `state` is its credential
  @Get("github-app/callback")
  callback(
    @Query("installation_id") installationId: string,
    @Query("state") state: string,
    @Query("setup_action") setupAction?: string,
  ): Promise<{ connectionId: string }> {
    return completeGithubAppInstall({ state, installationId, setupAction });
  }
}
