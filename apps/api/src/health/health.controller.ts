import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator";

/**
 * Liveness probe. Public (no bearer) so container orchestration / the compose
 * healthcheck can hit it without a token. Intentionally trivial — it reports the
 * process is up and serving HTTP, not that downstreams (Temporal/DB) are healthy
 * (a readiness probe with dependency checks is a later observability task).
 */
@Controller("healthz")
export class HealthController {
  @Public()
  @Get()
  check(): { status: "ok" } {
    return { status: "ok" };
  }
}
