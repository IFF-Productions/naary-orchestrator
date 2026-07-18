import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { EnvironmentSel, TenantId } from "../auth/tenant.decorator";
import { EnvSecretsService } from "../env-secrets/env-secrets.service";
import { EnvironmentsService } from "../environments/environments.service";
import { UsageService } from "../usage/usage.service";
import { VariablesService } from "../variables/variables.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { ApiTokenThrottlerGuard } from "./api-token-throttler.guard";
import { SetSecretDto, SetVariableDto } from "./v1-config.dto";
import {
  ConfigDeletedResponse,
  SecretNameResponse,
  SecretSetResponse,
  UsageResponse,
  VariableResponse,
} from "./v1-config.response";

/**
 * Public v1 config API — env-scoped workspace configuration: Global Variables ($vars), Environment
 * Secrets ($secrets), and the usage ledger. Thin over the SAME services the SPA uses, mapping into
 * v1-OWNED response DTOs (§5). tenantId comes from the token; the env from X-Environment-Id / an
 * env-bound token (never a path/body arg). Rate-limited per token ({@link ApiTokenThrottlerGuard}).
 *
 * SECURITY (CLAUDE.md Tier-1 §4): secrets are WRITE-ONLY. `GET secrets` returns NAMES only; `PUT
 * secrets/:name` acks without echoing the value; no endpoint returns, echoes, or logs a secret value.
 * The worker reads + decrypts a secret in-activity; the plaintext never reaches this controller.
 *
 * Mounted at v1/config; the `/api` prefix is stripped by the web proxy/nginx, so callers hit
 * /api/v1/config.
 */
@ApiTags("v1")
@ApiBearerAuth("bearer")
@UseGuards(ApiTokenThrottlerGuard)
@Controller("v1/config")
export class V1ConfigController {
  constructor(
    private readonly variables: VariablesService,
    private readonly secrets: EnvSecretsService,
    private readonly usage: UsageService,
    private readonly environments: EnvironmentsService,
  ) {}

  // ---- Variables ($vars) ------------------------------------------------------------------------

  @ApiEndpoint({
    summary: "List variables",
    description:
      "All Global Variables ($vars) for the active environment, as { key, value } (key-sorted).",
    ok: [VariableResponse],
  })
  @Get("variables")
  async listVariables(
    @TenantId() tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<VariableResponse[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    const rows = await this.variables.list(tenantId, envId);
    return rows.map((r) => ({ key: r.key, value: r.value }));
  }

  @ApiEndpoint({
    summary: "Set a variable",
    description:
      "Creates or overwrites the variable in the active env. 400 if the key isn't a valid `$vars.` identifier.",
    ok: VariableResponse,
  })
  @Put("variables/:key")
  async setVariable(
    @TenantId() tenantId: string,
    @Param("key") key: string,
    @Body() body: SetVariableDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<VariableResponse> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    const v = await this.variables.upsert(tenantId, envId, key, body.value);
    return { key: v.key, value: v.value };
  }

  @ApiEndpoint({
    summary: "Delete a variable",
    description: "Removes the variable from the active env (no-op if absent).",
    ok: ConfigDeletedResponse,
  })
  @Delete("variables/:key")
  async removeVariable(
    @TenantId() tenantId: string,
    @Param("key") key: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ deleted: true }> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    await this.variables.remove(tenantId, envId, key);
    return { deleted: true };
  }

  // ---- Secrets ($secrets) — WRITE-ONLY ----------------------------------------------------------

  @ApiEndpoint({
    summary: "List secret names",
    description:
      "The NAMES of the Environment Secrets ($secrets) configured for the active env. WRITE-ONLY: values are never returned (Tier-1 §4).",
    ok: [SecretNameResponse],
  })
  @Get("secrets")
  async listSecrets(
    @TenantId() tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<SecretNameResponse[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    const names = await this.secrets.list(tenantId, envId);
    return names.map((name) => ({ name }));
  }

  @ApiEndpoint({
    summary: "Set a secret",
    description:
      "Creates or replaces the secret's value in the active env (encrypted at rest). Returns an ack only — the value is never echoed. 400 if the name isn't a valid `$secrets.` identifier or the value is empty.",
    ok: SecretSetResponse,
  })
  @Put("secrets/:name")
  async setSecret(
    @TenantId() tenantId: string,
    @Param("name") name: string,
    @Body() body: SetSecretDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<SecretSetResponse> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    await this.secrets.set(tenantId, envId, name, body.value);
    // NEVER return the value — write-only invariant (Tier-1 §4).
    return { ok: true };
  }

  @ApiEndpoint({
    summary: "Delete a secret",
    description: "Removes the secret from the active env (no-op if absent).",
    ok: ConfigDeletedResponse,
  })
  @Delete("secrets/:name")
  async removeSecret(
    @TenantId() tenantId: string,
    @Param("name") name: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ deleted: true }> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    await this.secrets.remove(tenantId, envId, name);
    return { deleted: true };
  }

  // ---- Usage ------------------------------------------------------------------------------------

  @ApiEndpoint({
    summary: "Get usage",
    description:
      "Aggregated + per-call spend (tokens + cost only) for the token's tenant, optionally windowed by ISO ?from & ?to.",
    ok: UsageResponse,
  })
  @Get("usage")
  async getUsage(
    @TenantId() tenantId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<UsageResponse> {
    const s = await this.usage.getUsage(tenantId, from, to);
    return {
      totalCostUsd: s.totalCostUsd,
      totalTokens: s.totalTokens,
      byModel: s.byModel.map((m) => ({
        provider: m.provider,
        model: m.model,
        calls: m.calls,
        totalTokens: m.totalTokens,
        costUsd: m.costUsd,
      })),
      events: s.events.map((e) => ({
        id: e.id,
        executionId: e.executionId,
        nodeId: e.nodeId,
        provider: e.provider,
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        totalTokens: e.totalTokens,
        costUsd: e.costUsd,
        createdAt:
          e.createdAt instanceof Date ? e.createdAt.toISOString() : e.createdAt,
      })),
    };
  }
}
