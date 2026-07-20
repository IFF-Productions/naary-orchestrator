import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse } from "@nestjs/swagger";
import {
  completeGithubAppInstall,
  startGithubAppInstall,
} from "@naary/connections";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { EnvironmentSel } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { connectReturnUrl } from "./connect-return";
import { GithubAppInstallStartResponse } from "./connection.response";
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
  private readonly logger = new Logger(GithubAppController.name);
  constructor(private readonly environments: EnvironmentsService) {}

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
    @EnvironmentSel() envSel?: string,
  ): Promise<{ installUrl: string }> {
    // The connection is created in the callback (GitHub gives no install id until after consent),
    // so bind it to the caller's ACTIVE env now — the env rides in the (encoded) state to the
    // @Public callback, which can't send X-Environment-Id.
    const environmentId = await this.environments.resolveEnvId(
      tenantId,
      envSel,
    );
    // Return ONLY installUrl — the `state` is a single-use CSRF credential already embedded in
    // installUrl; surfacing it as a separate field would leak it out-of-band and diverge from
    // the Swagger contract (GithubAppInstallStartResponse has just installUrl).
    const { installUrl } = await startGithubAppInstall({
      tenantId,
      environmentId,
      label: body.label?.trim() || "GitHub",
    });
    return { installUrl };
  }

  @ApiOperation({
    summary: "GitHub App install callback (provider redirect target)",
    description:
      "Public: GitHub redirects the BROWSER here with `installation_id`, `setup_action`, and the " +
      "single-use `state`; creates the github_app connection, then 302-redirects back to the SPA " +
      "integrations page (`?connected=1` on success, `?connect_error=…` otherwise).",
  })
  @ApiResponse({
    status: 302,
    description: "Redirect to the SPA integrations page.",
  })
  @Public() // provider redirect target; the single-use `state` is its credential
  @Get("github-app/callback")
  async callback(
    @Res() res: Response,
    @Query("installation_id") installationId: string,
    @Query("state") state: string,
    @Query("setup_action") setupAction?: string,
  ): Promise<void> {
    // Browser-facing redirect target: never render a raw JSON body or a 500. On success bounce to
    // the integrations page; on failure do the same with an error flag and log the cause. The
    // common failure (a single-use `state` replayed after a successful install, or the 10-min TTL
    // expiring) is BENIGN — catching it here also keeps it out of Sentry as an unhandled 500.
    try {
      await completeGithubAppInstall({ state, installationId, setupAction });
      res.redirect(connectReturnUrl({ ok: true, tab: "apps" }));
    } catch (err) {
      this.logger.warn(
        `GitHub App install callback failed: ${(err as Error).message}`,
      );
      res.redirect(
        connectReturnUrl({ ok: false, tab: "apps", error: "github_app" }),
      );
    }
  }
}
