import { Controller, ForbiddenException, Get } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { isPlatformOperator } from "../auth/platform-operators";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { WorkerResponse } from "./worker.response";
import { WorkersService } from "./workers.service";

/**
 * Worker fleet registry (Queue-mode / Worker view). INFRA telemetry — which replicas are connected and
 * their live slot usage — not tenant data, so it is not scoped by tenant.
 *
 * Gated on PLATFORM OPERATOR, not workspace role. The previous `principal.role === "owner" | "admin"`
 * check read the caller's role in their OWN workspace, and in self-serve SaaS everyone who signs up
 * owns one — so it admitted every customer to the whole global fleet: hostnames, PIDs, worker versions
 * and slot counts, from which the platform's size and load are readable. See ../auth/platform-operators.
 *
 * FAIL CLOSED: with `PLATFORM_OPERATORS` unset nobody qualifies and this 403s for everyone (the SPA
 * hides the nav entry to match). Self-hosted installs that want the view set their own email.
 */
@ApiBearerAuth("bearer")
@Controller("workers")
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  @ApiEndpoint({
    summary: "List worker replicas",
    description:
      "The connected worker fleet with live slot usage (activeActivities/maxActivities), version, and online/stale. PLATFORM OPERATORS only (PLATFORM_OPERATORS env allowlist) — infra telemetry, not tenant data. 403s for everyone when that env is unset.",
    ok: [WorkerResponse],
  })
  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkerResponse[]> {
    // Fleet/infra data is PLATFORM-operator-only — owning a workspace says nothing about operating the
    // deployment. Unset PLATFORM_OPERATORS ⇒ nobody, by design.
    if (!isPlatformOperator(principal)) {
      throw new ForbiddenException(
        "The worker fleet is visible to platform operators only.",
      );
    }
    return this.workers.list();
  }
}
