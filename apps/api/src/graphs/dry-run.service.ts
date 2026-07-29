/**
 * DRY RUN — answer "will this flow run?" without executing anything.
 *
 * Asked for as: "try a dry run without destructive changes, maybe provide user an option to do
 * that?" The problem it exists for (#830): a generated flow's problems were only discoverable by
 * running it, one failure per run — "I have to test the flow like 100 times to debug whats going on".
 *
 * Three layers, cheapest first, and NONE of them executes a node:
 *
 *   1. CONFIG   — pure catalog validation (unknown provider/action, missing REQUIRED fields, no
 *                 connection). Free, and the same check the canvas and the save gate already use.
 *   2. REQUEST  — build the real HTTP request with `buildIntegrationRequest` (pure, no I/O), so a
 *                 malformed path/body — a CR/LF in a header field, a nested value on a
 *                 form-encoded action — is caught before anything is ever sent.
 *   3. CREDENTIAL — the ONLY layer that touches the network: the existing connection test, which
 *                 by construction probes the provider's cheapest `write: false` action. This is
 *                 what catches "the connection exists but the token is dead or lacks scope",
 *                 otherwise discoverable only by a real run.
 *
 * WHAT IT WILL NEVER DO: execute a node. A dry run that fires write actions is not a dry run. The
 * probe action comes from `pickConnectionTestAction`, which filters on the catalog's own `write`
 * flag — so "non-destructive" is a property of the catalog, not of a promise made here.
 *
 * COVERAGE (#835): layer 3 reaches 31 of 38 providers — every one with an argument-free, read-only
 * GET in the catalog, including GitHub (both a PAT and a GitHub App installation, which need
 * different probes), Jira, Notion, GitLab, Discord, Mattermost and 11 others. The remaining SEVEN
 * are unprobed on purpose, each with a declared reason (`unprobeableReason`): Slack answers HTTP 200
 * with `{"ok": false}` to a dead token, Linear/Monday/Dropbox are POST-only, Microsoft Graph's `/me`
 * is delegated-token-only, HubSpot's cheapest argument-free read is scope-gated (a deals-only token
 * would 403 and be reported dead), and Google Sheets has no identity endpoint on its own host. Those
 * report `skipped` WITH the reason — never a pass. Layers 1–2 still cover all 38.
 *
 * Each connection is probed ONCE even when several nodes share it: the verdict is about the
 * credential, not the node, and a flow with six GitHub steps shouldn't cost six probes.
 */
import { Injectable, Logger } from "@nestjs/common";
import {
  type GraphDef,
  buildIntegrationRequest,
  validateIntegrationConfig,
} from "@naary/dsl";
import { ConnectionTestService } from "../connections/connection-test.service";

/** One check against one node. `ok:false` is a problem; `skipped` means the check didn't apply. */
export interface DryRunCheck {
  kind: "config" | "request" | "credential";
  ok: boolean;
  /** Present when `ok` is false, or when a check was skipped and the reason is useful. */
  message?: string;
  /** True when the check couldn't run (e.g. no probe exists for this provider) — NOT a failure. */
  skipped?: boolean;
}

export interface DryRunNodeResult {
  nodeId: string;
  type: string;
  checks: DryRunCheck[];
}

export interface DryRunResult {
  /** False when ANY check failed. A skipped check never fails the run. */
  ok: boolean;
  /**
   * How many connections we actually called out to — the only part that costs anything. A
   * connection we declined to probe (no zero-argument read exists) is NOT counted: it made no
   * request, so counting it would overstate both the cost and the strength of the verdict.
   */
  probed: number;
  /** Connections skipped for want of a probe — the gap between `probed` and full coverage (#835). */
  unprobeable: number;
  nodes: DryRunNodeResult[];
}

@Injectable()
export class DryRunService {
  private readonly logger = new Logger(DryRunService.name);

  constructor(private readonly connectionTest: ConnectionTestService) {}

  async check(tenantId: string, graph: GraphDef): Promise<DryRunResult> {
    const nodes: DryRunNodeResult[] = [];
    /** connectionId+provider → verdict, so a shared connection is probed once. */
    const probes = new Map<string, DryRunCheck>();

    for (const node of graph.nodes) {
      if (node.type !== "integration") continue;
      const cfg = (node.config ?? {}) as Record<string, unknown>;
      const checks: DryRunCheck[] = [];

      // 1. CONFIG — the same validation the canvas and the save gate run.
      const configError = validateIntegrationConfig(
        cfg as unknown as Parameters<typeof validateIntegrationConfig>[0],
      );
      checks.push(
        configError
          ? { kind: "config", ok: false, message: configError }
          : { kind: "config", ok: true },
      );

      const provider = typeof cfg.provider === "string" ? cfg.provider : "";
      const action = typeof cfg.action === "string" ? cfg.action : "";
      const connectionId =
        typeof cfg.connectionId === "string" ? cfg.connectionId : "";

      // 2. REQUEST — pure. Only attempted when the config is sound; otherwise the failure would
      // just restate the config error in less useful words.
      if (!configError) {
        try {
          const fields = (cfg.fields ?? {}) as Record<string, unknown>;
          buildIntegrationRequest(provider, action, fields);
          checks.push({ kind: "request", ok: true });
        } catch (e) {
          checks.push({
            kind: "request",
            ok: false,
            message:
              e instanceof Error ? e.message : "could not build the request",
          });
        }
      }

      // 3. CREDENTIAL — the only network call, and only against a `write: false` probe.
      //
      // DELIBERATELY still probed when the config check failed, unlike the request check. The
      // request check would only restate the config error; the credential check answers a
      // DIFFERENT question — "is this token alive?" — and its answer is just as true on a node
      // whose config is also wrong. Short-circuiting here would hand the user one problem, then
      // the next one on the following check, which is precisely the fix-run-repeat loop this
      // feature exists to end (#830). The cost is bounded: one call per distinct connection,
      // and a broken node usually shares its connection with a working one anyway.
      if (connectionId && provider) {
        const key = `${connectionId}:${provider}`;
        let verdict = probes.get(key);
        if (!verdict) {
          verdict = await this.probe(tenantId, connectionId, provider);
          probes.set(key, verdict);
        }
        checks.push(verdict);
      }

      nodes.push({ nodeId: node.id, type: node.type, checks });
    }

    const verdicts = [...probes.values()];
    const result: DryRunResult = {
      ok: nodes.every((n) => n.checks.every((c) => c.ok || c.skipped)),
      probed: verdicts.filter((v) => !v.skipped).length,
      unprobeable: verdicts.filter((v) => v.skipped).length,
      nodes,
    };
    this.logger.log(
      `dry run: ${nodes.length} node(s), ${result.probed} credential probe(s), ` +
        `${result.unprobeable} unprobeable, ok=${result.ok}`,
    );
    return result;
  }

  /**
   * Probe one credential. Never throws: a dry run reports problems, so an unreachable provider is a
   * RESULT, not an error that loses the other nodes' verdicts.
   */
  private async probe(
    tenantId: string,
    connectionId: string,
    provider: string,
  ): Promise<DryRunCheck> {
    try {
      const res = await this.connectionTest.test(
        tenantId,
        connectionId,
        provider,
      );
      if (res.status === "unknown") {
        // No zero-argument read exists for this provider (e.g. GitHub) — we declined to probe.
        // Not a failure: reporting it as one would train people to ignore the result.
        return {
          kind: "credential",
          ok: true,
          skipped: true,
          message: res.message,
        };
      }
      return { kind: "credential", ok: res.ok, message: res.message };
    } catch (e) {
      return {
        kind: "credential",
        ok: false,
        message: e instanceof Error ? e.message : "the connection check failed",
      };
    }
  }
}
