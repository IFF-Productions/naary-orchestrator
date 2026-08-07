import "reflect-metadata";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_PROVIDERS,
  validateIntegrationConfig,
  type GraphDef,
} from "@naary/dsl";
import {
  GraphGeneratorService,
  __genDeps,
} from "../src/graphs/graph-generator.service";

/**
 * LIVE reproduction for the reported failure: "every time I build with AI, the workflow fails
 * whenever there is a 3rd party integration."
 *
 * REAL model, REAL `SYSTEM_PROMPT`, REAL integration catalog, REAL resource grounding, REAL
 * validate → self-repair → connection-scrub pipeline. Only the two injected services are stubs (a
 * fixed provider key, a fixed connection list) — those are DB reads, not the thing under test. So
 * this measures exactly what a user gets from "Build with AI" when their workspace ALREADY has the
 * connections the request needs.
 *
 * It scores each generated graph on the three things that decide whether the flow actually runs:
 *   1. did it reach for a native `integration` node at all, or fake the integration with a raw
 *      `httpRequest` to a made-up third-party URL (which nothing in the product validates)?
 *   2. does every integration node pass the SAVE GATE (`validateIntegrationConfig`) apart from the
 *      connectionId, which is the author's to pick?
 *   3. are the field VALUES real, or `<placeholders>` the run would send verbatim?
 *
 * Generation is stochastic, so every request runs GEN_LIVE_RUNS times (default 3) and the report is
 * counts, not a single sample.
 *
 * TWO WAYS TO RUN — both are the product's own code path, pick whichever credential you have:
 *
 *   ANTHROPIC_TEST_KEY=sk-ant-…                    the API-model path (`generateText`), the default
 *   GEN_LIVE_PROVIDER=claude-code                  the headless-CLI path, using the `claude` CLI
 *                                                  already logged in on this machine
 *
 * The claude-code mode replaces `__genDeps.runSandbox` with a LOCAL `execFile("claude", …)` in an
 * empty temp directory. That seam exists because the API dispatches the CLI to the sandbox-runner
 * container (#680), which a dev checkout does not have; the arguments, the prompt and everything
 * downstream of the CLI's answer are the shipped ones. The CLI uses its own login, so this mode
 * needs no key in the environment at all.
 *
 * Writes a JSON report to GEN_LIVE_REPORT when set.
 */

const PROVIDER = process.env.GEN_LIVE_PROVIDER ?? "anthropic";
const CLI_MODE = PROVIDER === "claude-code";
const ANTHROPIC_KEY = process.env.ANTHROPIC_TEST_KEY;
const ENABLED = CLI_MODE || Boolean(ANTHROPIC_KEY);
const RUNS = Number(process.env.GEN_LIVE_RUNS ?? 3);
const REPORT = process.env.GEN_LIVE_REPORT;

/** A workspace that HAS the connections these requests need — so "the prompt tells the model not to
 *  add integration nodes when there are none" cannot explain anything measured here. */
const CONNECTIONS =
  process.env.GEN_LIVE_CONNECTIONS === "none"
    ? []
    : [
        { id: "conn_gh_01", type: "github", label: "GitHub — acme org" },
        { id: "conn_slack_01", type: "custom", label: "Slack workspace" },
        {
          id: "conn_jira_01",
          type: "atlassian",
          label: "Jira — acme.atlassian.net",
        },
      ];

/**
 * `valuesSupplied` is the difference between "the generator got it wrong" and "the author still has
 * to type their board id". When the request names every value, a leftover gap IS a defect. When it
 * doesn't, the only defensible outcome is a gap that gets REPORTED — which is the entire fix: a
 * blank field is named by the save gate and the canvas issues panel, a `<slot>` is named by nothing
 * and reaches the provider.
 */
const SETS: Record<
  string,
  { id: string; text: string; valuesSupplied: boolean }[]
> = {
  // Requests where the USER spells out every value the action needs.
  default: [
    {
      id: "gh-issue-to-slack",
      valuesSupplied: true,
      text: "When a GitHub issue is opened in acme/widgets, post a message about it to the #alerts channel in Slack.",
    },
    {
      id: "form-to-jira",
      valuesSupplied: true,
      text: "When someone submits a support form (name, email, description), create a Jira ticket of type Task in project OPS with the description.",
    },
    {
      id: "standup-summary",
      valuesSupplied: true,
      text: "Every weekday at 9am, comment on GitHub issue 42 of acme/widgets with a short standup reminder, then post the same reminder to the Slack channel #standup.",
    },
  ],
  // Providers whose required fields are NOT self-describing: Notion's `parent`/`properties` are
  // JSON of a shape the key name does not hint at, monday's `query`/`variables` are a GraphQL
  // document, Twilio's `From`/`To`/`Body` are form-encoded and case-sensitive.
  hard: [
    {
      id: "notion-page",
      valuesSupplied: false,
      text: "When a support form is submitted, create a page in my Notion database with the submitter's name as the title.",
    },
    {
      id: "monday-item",
      valuesSupplied: false,
      text: "When a webhook fires with a new lead, create an item for it on my monday.com board.",
    },
    {
      id: "twilio-sms",
      valuesSupplied: false,
      text: "When a PagerDuty-style webhook reports an incident, send me an SMS about it with Twilio.",
    },
  ],
};
const REQUESTS = SETS[process.env.GEN_LIVE_SET ?? "default"];

/** Hosts that mean "the model hand-rolled a third-party API call instead of using the catalog". */
const THIRD_PARTY_HOST =
  /(slack\.com|github\.com|atlassian\.net|atlassian\.com|jira\.com)/i;
/** Field values a run would send to the provider verbatim. */
// `<angle-bracket>` slots only — NOT `<{{ x }}>`, which is a filled expression that happens to sit
// inside literal angle brackets (an email address in a sentence).
const PLACEHOLDER =
  /<[A-Za-z][\w .-]*>|YOUR[_-]|xxxx|example\.com|\bTODO\b|placeholder/i;

interface NodeLike {
  id: string;
  type: string;
  config?: Record<string, unknown>;
}

interface Score {
  request: string;
  run: number;
  /** native integration nodes emitted */
  integrationNodes: number;
  /** httpRequest nodes pointed at a catalogued provider's API — a faked integration */
  fakedIntegrations: number;
  /** integration nodes failing the save gate for something OTHER than the connectionId */
  configErrors: string[];
  /** `<placeholder>`-shaped field values on integration nodes */
  placeholderFields: string[];
  nodeTypes: string[];
  error?: string;
  /** the raw graph, kept only for the GEN_LIVE_REPORT dump */
  graph?: GraphDef;
}

function scoreGraph(request: string, run: number, graph: GraphDef): Score {
  const nodes = graph.nodes as unknown as NodeLike[];
  const score: Score = {
    request,
    run,
    integrationNodes: 0,
    fakedIntegrations: 0,
    configErrors: [],
    placeholderFields: [],
    nodeTypes: nodes.map((n) => n.type),
    graph,
  };
  for (const node of nodes) {
    if (node.type === "httpRequest") {
      if (THIRD_PARTY_HOST.test(String(node.config?.url ?? "")))
        score.fakedIntegrations += 1;
      continue;
    }
    if (node.type !== "integration") continue;
    score.integrationNodes += 1;
    const cfg = (node.config ?? {}) as Record<string, unknown>;
    // Score the CONFIG the model wrote, not the connection the author still has to pick: hand the
    // gate a real connectionId so the only errors left are the model's.
    const err = validateIntegrationConfig({
      ...cfg,
      connectionId: "conn_probe",
    } as never);
    if (err) score.configErrors.push(`${node.id}: ${err}`);
    // WALK the value, don't just test it: a `json` field hides its slots one level down
    // (`parent: { database_id: "<your-database-id>" }`), which is where half of them were.
    const walk = (v: unknown, at: string): void => {
      if (typeof v === "string") {
        if (PLACEHOLDER.test(v)) score.placeholderFields.push(`${at}=${v}`);
      } else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v as Record<string, unknown>))
          walk(x, `${at}.${k}`);
      }
    };
    walk(cfg.fields ?? {}, node.id);
  }
  return score;
}

/** Run the shipped CLI argv locally, in an EMPTY directory (the runner's ephemeral workspace). */
function installLocalCliSeam(): void {
  process.env.SANDBOX_RUNNER_URL ||= "http://local-cli";
  process.env.SANDBOX_RUNNER_TOKEN ||= "local";
  __genDeps.runSandbox = (body, opts) =>
    new Promise((resolve) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "naary-gen-"));
      execFile(
        "claude",
        body.agentArgs as string[],
        { cwd, timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          fs.rmSync(cwd, { recursive: true, force: true });
          resolve({
            exitCode: err ? ((err as { code?: number }).code ?? 1) : 0,
            stdout,
            stderr,
          });
        },
      );
    });
}

function makeService(): GraphGeneratorService {
  return new GraphGeneratorService(
    {
      getDecryptedKey: async () => ANTHROPIC_KEY ?? "unused-by-the-local-cli",
      listProviders: async () => [{ provider: PROVIDER, isValid: true }],
    } as never,
    { list: async () => CONNECTIONS } as never,
  );
}

const all: Score[] = [];

describe.skipIf(!ENABLED)("AI builder — third-party integrations", () => {
  if (CLI_MODE) installLocalCliSeam();

  for (const req of REQUESTS) {
    it(`${req.id}: generates runnable integration nodes (${RUNS} runs)`, async () => {
      const svc = makeService();
      const results = await Promise.all(
        Array.from({ length: RUNS }, (_, i) =>
          svc
            .generate("t-live", "e-live", req.text, PROVIDER, {
              timeoutMs: 300_000,
            })
            .then((g) => scoreGraph(req.id, i, g.graph))
            .catch((e: Error): Score => ({
              request: req.id,
              run: i,
              integrationNodes: 0,
              fakedIntegrations: 0,
              configErrors: [],
              placeholderFields: [],
              nodeTypes: [],
              error: e.message,
            })),
        ),
      );
      for (const s of results) {
        all.push(s);
        // eslint-disable-next-line no-console
        console.log(
          `[${req.id}#${s.run}] nodes=${s.nodeTypes.join(",")} integration=${s.integrationNodes} faked=${s.fakedIntegrations} errors=${s.configErrors.length} placeholders=${s.placeholderFields.length}${s.error ? ` FAILED=${s.error}` : ""}`,
        );
        // eslint-disable-next-line no-console
        for (const e of s.configErrors) console.log(`    ERR  ${e}`);
        // eslint-disable-next-line no-console
        for (const p of s.placeholderFields) console.log(`    PLC  ${p}`);
      }

      // 1. The request names providers the catalog covers and the workspace HAS the connections,
      //    so a native integration node is the only right answer.
      expect(
        results.filter((s) => s.integrationNodes > 0).length,
        "runs that used a native integration node",
      ).toBe(RUNS);
      // 2. No hand-rolled httpRequest standing in for a catalogued provider.
      expect(
        results.reduce((n, s) => n + s.fakedIntegrations, 0),
        "httpRequest nodes faking a catalogued provider",
      ).toBe(0);
      // 3. NEVER a slot the run would send to the provider verbatim — the actual bug. This holds
      //    whether or not the request named the values: not knowing one is fine, faking it is not.
      expect(results.flatMap((s) => s.placeholderFields)).toEqual([]);
      // 4. When the request DID name every value, nothing may be left for the author to fix. When
      //    it didn't, a gap is expected — but it has to be one the save gate REPORTS, which is
      //    what assertion 3 plus this asymmetry pins down.
      if (req.valuesSupplied) {
        expect(results.flatMap((s) => s.configErrors)).toEqual([]);
      }
    }, 900_000);
  }

  it("reports the totals", () => {
    const summary = {
      provider: PROVIDER,
      providers: INTEGRATION_PROVIDERS.length,
      runs: all.length,
      usedIntegration: all.filter((s) => s.integrationNodes > 0).length,
      faked: all.reduce((n, s) => n + s.fakedIntegrations, 0),
      configErrors: all.reduce((n, s) => n + s.configErrors.length, 0),
      placeholders: all.reduce((n, s) => n + s.placeholderFields.length, 0),
      failed: all.filter((s) => s.error).length,
    };
    // eslint-disable-next-line no-console
    console.log("SUMMARY", JSON.stringify(summary));
    if (REPORT) {
      fs.mkdirSync(path.dirname(REPORT), { recursive: true });
      fs.writeFileSync(REPORT, JSON.stringify({ summary, all }, null, 2));
    }
    expect(summary.runs).toBeGreaterThan(0);
  });
});
