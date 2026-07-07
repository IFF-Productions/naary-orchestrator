import { Controller, Get, Header } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { metricsContentType, renderMetrics } from "@naary/metrics";
import { Public } from "../auth/public.decorator";

/**
 * Prometheus scrape endpoint. `@Public` — scrapers don't carry an app token; in a
 * real deployment this is network-restricted (not exposed publicly).
 */
@ApiExcludeController() // Prometheus text exposition, not a JSON REST endpoint.
@Controller("metrics")
export class MetricsController {
  @Get()
  @Public()
  @Header("content-type", metricsContentType)
  metrics(): Promise<string> {
    return renderMetrics();
  }
}
