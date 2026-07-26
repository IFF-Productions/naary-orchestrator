import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ConnectionService, type ConnectionView } from "@naary/connections";
import { EnvironmentSel } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { GraphsService } from "../graphs/graphs.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  ConnectionResponse,
  ConnectionTestResponse,
} from "./connection.response";
import {
  type ConnectionTestResult,
  ConnectionTestService,
} from "./connection-test.service";
import { CreateConnectionDto } from "./create-connection.dto";
import { TestConnectionDto } from "./test-connection.dto";

@ApiBearerAuth("bearer")
@Controller("tenants/:id/connections")
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionService,
    private readonly environments: EnvironmentsService,
    private readonly graphs: GraphsService,
    private readonly connectionTest: ConnectionTestService,
  ) {}

  @ApiEndpoint({
    summary: "Create a connection",
    description:
      "Stores a connection for the tenant; secret token (PAT/DSN) is encrypted, never returned.",
    created: ConnectionResponse,
  })
  @Post()
  async create(
    @Param("id") tenantId: string,
    @Body() body: CreateConnectionDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<ConnectionView> {
    // Env-scoped (Slice 5): the connection lands in the caller's active env — a sandbox run binds
    // to sandbox integrations, prod to prod.
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.connections.create(tenantId, envId, body);
  }

  @ApiEndpoint({
    summary: "List connections",
    ok: [ConnectionResponse],
  })
  @Get()
  async list(
    @Param("id") tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<
    Array<
      ConnectionView & {
        usedByNodeCount: number;
        credentialLast4: string | null;
      }
    >
  > {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    // Connections + their reference counts + credential last-4 (#471) in parallel — all env-scoped
    // to `envId`. The last-4 is decrypted in the service and only the 4-char fragment reaches here;
    // the full token never crosses this boundary.
    const [conns, usage, last4] = await Promise.all([
      this.connections.list(tenantId, envId),
      this.graphs.connectionUsageCounts(tenantId, envId),
      this.connections.credentialLast4Map(tenantId, envId),
    ]);
    return conns.map((c) => ({
      ...c,
      usedByNodeCount: usage[c.id] ?? 0,
      credentialLast4: last4[c.id] ?? null,
    }));
  }

  /**
   * Test a saved connection against the real provider (#701) — the check that was missing:
   * a connection used to be stored and reported `connected` without anyone ever asking the
   * provider whether the token works.
   *
   * Runs the provider's cheapest **non-write, zero-required-field** catalog read through the SAME
   * request builder the `integration` node uses (`planIntegrationCall`), so a pass proves the
   * header scheme, base URL and token the node will really use. Never writes: the action is derived
   * from the catalog's `write` flag, and a provider with no such action (Slack) reports `unknown`.
   *
   * RBAC: gated by the auth guard's tenant scoping only, exactly like the sibling create/list/delete
   * routes on this controller. The RBAC matrix's verbs (`view|run|edit|delete|share`,
   * RBAC-GROUPS.md §4) are per-WORKFLOW and none of them applies to a connection; gating a
   * read-only probe more tightly than the DELETE right above it would be incoherent, and a member
   * who can save a connection must be able to test it from the connect form.
   */
  @ApiEndpoint({
    summary: "Test a connection against its provider",
    description:
      "Calls the provider's cheapest read-only, zero-argument catalog action with this " +
      "connection's credential and reports whether it was accepted, updating the connection's " +
      "status. Never performs a write; providers with no such action report `unknown`.",
    ok: ConnectionTestResponse,
    notFound: true,
  })
  @Post(":connectionId/test")
  test(
    @Param("id") tenantId: string,
    @Param("connectionId") connectionId: string,
    @Body() body: TestConnectionDto,
  ): Promise<ConnectionTestResult> {
    // No env resolution here: a connection is looked up by its own id (tenant-scoped), and the
    // secret is read from the connection row's OWN environmentId inside resolveAuthHeader — so the
    // probe always uses the env the connection actually lives in, not the caller's active env.
    return this.connectionTest.test(tenantId, connectionId, body.provider);
  }

  @ApiEndpoint({
    summary: "Delete a connection",
    description:
      "Removes the connection and its stored secret (204 No Content).",
  })
  @Delete(":connectionId")
  @HttpCode(204)
  remove(
    @Param("id") tenantId: string,
    @Param("connectionId") connectionId: string,
  ): Promise<void> {
    return this.connections.remove(tenantId, connectionId);
  }
}
