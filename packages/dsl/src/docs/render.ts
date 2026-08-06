/**
 * Renders one provider's setup guide in `docs/integrations/{key}.md`.
 *
 * THE SPLIT, which is the whole point of this file:
 *   - CATALOG-DERIVED (this renderer, never hand-edit the output): the action table, the auth
 *     header sentence, whether a Server URL is required, whether Test Connection can probe the
 *     provider, the frontmatter. These come from `INTEGRATION_PROVIDERS` and therefore cannot
 *     disagree with what the `integration` node actually sends.
 *   - HAND-WRITTEN (`integration-prose.ts`): where the credential lives in the provider's console,
 *     which scopes it needs, and the traps. A machine cannot know these.
 *
 * The generated files are COMMITTED (so the docs are browsable and the marketing site can read
 * them straight from the repo) and enforced by `packages/dsl/test/integration-docs.spec.ts`, which
 * re-renders every provider and diffs against disk. Hand-edit a generated section and that test
 * fails — which is the only reason the corpus can be trusted as a source for anything downstream.
 *
 * Regenerate with `pnpm gen:integration-docs`.
 */
import type { IntegrationAction, IntegrationProvider } from "../integrations";
import { pickConnectionTestAction } from "../integration-request";
import type { IntegrationProse } from "./integration-prose";

/**
 * Providers with a `*.live.spec.ts` that calls the REAL API with a real credential — i.e. the only
 * ones we can honestly say "this works". Today: GitHub, via
 * `apps/worker/test/github-agent.live.spec.ts`.
 *
 * Everything else is typed and unit-tested against the catalog and has never touched the live
 * service (see `docs/integrations/VERIFICATION.md` §7). Add a key here ONLY when a live spec covers
 * it — the whole value of the `liveVerified` flag is that it cannot be inflated by good intentions.
 */
export const LIVE_VERIFIED: ReadonlySet<string> = new Set(["github"]);

/** Marker written into every generated file so a human editing one knows what will be lost. */
export const GENERATED_NOTICE =
  "<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via\n" +
  "     `pnpm gen:integration-docs`. Edit the catalog (or\n" +
  "     packages/dsl/src/docs/integration-prose.ts for the prose), never this file —\n" +
  "     packages/dsl/test/integration-docs.spec.ts fails on drift. -->";

/** How the token actually reaches the wire, derived from `authScheme` (see integration.ts). */
export function authStyle(p: IntegrationProvider): {
  id: "bearer" | "basic" | "custom-header";
  sentence: string;
} {
  const s = p.authScheme;
  if (s === "basic") {
    return {
      id: "basic",
      sentence:
        "HTTP Basic — Naary base64-encodes the credential pair for you. Paste the raw `user:secret` pair, not a pre-encoded string.",
    };
  }
  if (typeof s === "object" && s !== null) {
    const prefix = s.prefix ?? "";
    const shown = prefix ? `${prefix}<token>` : "<token>";
    return {
      id: "custom-header",
      sentence:
        `A custom header: \`${s.header}: ${shown}\`` +
        (prefix ? "" : " — a **bare** value, with no `Bearer ` prefix") +
        ". Naary applies this for you; paste only the token itself.",
    };
  }
  return {
    id: "bearer",
    sentence:
      "A standard `Authorization: Bearer <token>` header. Paste only the token.",
  };
}

/**
 * Does the user have to supply a Server URL? `baseUrlFromConnection` is the catalog's intent flag;
 * the `!baseUrl` fallback keeps this correct if a provider is added with neither set. Today the two
 * agree exactly (6 providers), and this is the single most common setup failure, so it is derived
 * rather than restated in prose.
 */
export function needsServerUrl(p: IntegrationProvider): boolean {
  return p.baseUrlFromConnection === true || !p.baseUrl;
}

/**
 * Fields the USER must supply. A `required` field carrying a `const` is supplied by the catalog
 * (PagerDuty's `type: "incident"` discriminators — 7 of them today) and the user never sees it, so
 * listing it as required would send someone hunting for a field that isn't in the config panel.
 */
function requiredKeys(a: IntegrationAction): string[] {
  return (a.fields ?? [])
    .filter((f) => f.required && f.const === undefined)
    .map((f) => f.key);
}

function optionalKeys(a: IntegrationAction): string[] {
  return (a.fields ?? [])
    .filter((f) => !f.required && f.const === undefined)
    .map((f) => f.key);
}

/**
 * End a prose FRAGMENT with a full stop before another sentence follows it.
 *
 * `prose.serverUrl` is authored as a fragment ("your Atlassian site, e.g. `…`") because it is also
 * dropped into "Set **Server URL** to …". Pasted straight in front of the next sentence it produced
 * "…`us19`) Getting this wrong is…" — two sentences run together, in every Server-URL guide.
 */
function sentence(fragment: string): string {
  return /[.!?]$/.test(fragment.trim()) ? fragment : `${fragment}.`;
}

/** "a token" / "an API key" — the guides read as prose, so this shouldn't be left to chance. */
function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? "an" : "a";
}

/**
 * The action Test Connection would probe.
 *
 * Asks `pickConnectionTestAction` — the SAME function the route calls — rather than re-deriving the
 * rule here. It used to be a copy ("first non-write GET with no required fields"), which was fine
 * while the rule was one line and became a drift risk the moment #835 added declared probes and
 * auth-mode variants. No `authMode` is passed: the docs answer the capability question ("can this
 * provider be checked at all?"), and a per-connection variant (GitHub App) is prose, not frontmatter.
 */
export function probeAction(
  p: IntegrationProvider,
): IntegrationAction | undefined {
  const probe = pickConnectionTestAction(p.key);
  if (probe.kind !== "read") return undefined;
  return (p.actions ?? []).find((a) => a.key === probe.action);
}

function actionRow(a: IntegrationAction): string {
  const req = requiredKeys(a);
  const opt = optionalKeys(a);
  const label = a.write ? `**${a.label}** (write)` : a.label;
  return `| ${label} | \`${a.method}\` | \`${a.pathTemplate}\` | ${
    req.length ? req.map((k) => `\`${k}\``).join(", ") : "—"
  } | ${opt.length ? opt.map((k) => `\`${k}\``).join(", ") : "—"} |`;
}

/** YAML-safe single-quoted scalar. */
function yq(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Frontmatter — the machine-readable half, for the gallery and the marketing site.
 * `liveVerified` is deliberately present and honest: it is true only where a `*.live.spec.ts`
 * proves the provider against the real API, which today is GitHub alone. It flips per provider as
 * real proof lands, and nothing downstream should imply "works" from mere presence in the catalog.
 */
function frontmatter(
  p: IntegrationProvider,
  prose: IntegrationProse,
  liveVerified: boolean,
): string {
  const probe = probeAction(p);
  const writes = (p.actions ?? []).filter((a) => a.write).length;
  return [
    "---",
    `title: ${yq(prose.tagline)}`,
    `provider: ${p.key}`,
    `label: ${yq(p.label)}`,
    `category: ${yq(prose.category)}`,
    `authType: ${authStyle(p).id}`,
    `serverUrlRequired: ${needsServerUrl(p)}`,
    `actionCount: ${(p.actions ?? []).length}`,
    `writeActionCount: ${writes}`,
    `oneClickTestable: ${probe !== undefined}`,
    probe ? `probeAction: ${probe.key}` : null,
    `liveVerified: ${liveVerified}`,
    "---",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/** The whole page. */
export function renderIntegrationDoc(
  p: IntegrationProvider,
  prose: IntegrationProse,
  opts: { liveVerified: boolean },
): string {
  const auth = authStyle(p);
  const probe = probeAction(p);
  const actions = p.actions ?? [];
  const writes = actions.filter((a) => a.write);
  /** No reads at all (e.g. Slack): the docs must not send the reader looking for one. */
  const allWrite = actions.length > 0 && writes.length === actions.length;
  const out: string[] = [];

  out.push(frontmatter(p, prose, opts.liveVerified));
  out.push("");
  out.push(GENERATED_NOTICE);
  out.push("");
  out.push(`# ${p.label}`);
  out.push("");
  out.push(prose.tagline);
  out.push("");

  // ---- Before you start (GENERATED shape, prose values) ------------------------------------
  out.push("## Before you start");
  out.push("");
  out.push(
    `- **You need:** ${article(prose.credentialName)} ${prose.credentialName}.`,
  );
  if (prose.scopes) out.push(`- **Scopes / permissions:** ${prose.scopes}`);
  out.push(`- **How the token is sent:** ${auth.sentence}`);
  if (!needsServerUrl(p)) {
    out.push(
      `- **Server URL:** not needed — Naary always calls \`${p.baseUrl}\`.`,
    );
  } else {
    // `defaultBaseUrl` is deliberately NOT written up as "you can leave this blank" (#1110): the
    // Connect form requires an https Server URL and the create-connection DTO rejects an empty
    // one, so no reader of this page can take that path. It is a compatibility fallback for rows
    // created before the provider asked for a host — a fact about why nothing broke, not an
    // instruction — so it is stated as exactly that, in the past tense, after the requirement.
    out.push(
      // The trailing sentence is a claim about a SYMPTOM, so it is overridable (#1109): for
      // Shopify a stale version segment keeps returning 200, and for PostHog a wrong region
      // answers 401 — pointing either of them at a 404 sends them to re-check the wrong thing.
      `- **Server URL: required.** ${sentence(
        prose.serverUrl ?? "Set it to your instance's API base",
      )} ${sentence(
        prose.serverUrlFailure ??
          "Getting this wrong is the most common cause of a setup that looks right and 404s",
      )}` +
        (p.defaultBaseUrl
          ? ` (${p.label} connections made *before* this field was asked for store no host and keep` +
            ` calling \`${p.defaultBaseUrl}\`, so none of them broke — but every new connection sets it.)`
          : ""),
    );
  }
  out.push("");

  // ---- Get your credentials (PROSE) -------------------------------------------------------
  out.push("## Get your credentials");
  out.push("");
  prose.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  out.push("");

  // ---- Connect it (GENERATED) -------------------------------------------------------------
  out.push("## Connect it in Naary");
  out.push("");
  out.push("1. Go to **Integrations → Connect a server**.");
  out.push(
    `2. Pick the **${p.label}** tile (or *Custom* if you are configuring it by hand).`,
  );
  out.push(
    !needsServerUrl(p)
      ? "3. Leave **Server URL** as the default — this provider has a fixed API base."
      : // No "or leave it blank" variant here even for a provider with a `defaultBaseUrl` — this is
        // the step list for making a NEW connection, and that path rejects an empty Server URL.
        `3. Set **Server URL** to ${prose.serverUrl ?? "your instance's API base"}.`,
  );
  out.push("4. Paste the credential into the token field and save.");
  out.push(
    "5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.",
  );
  out.push("");

  // ---- Verify (GENERATED from the probe rule) ---------------------------------------------
  out.push("## Verify it works");
  out.push("");
  if (probe) {
    out.push(
      `**One-click:** this provider has an argument-free read (\`${probe.key}\` → \`${probe.method} ${probe.pathTemplate}\`), so a connection test can confirm the credential without touching your data.`,
    );
  } else {
    out.push(
      `**No one-click check:** ${
        allWrite
          ? "every action here writes"
          : "its read actions all need an id you have to supply"
      }, so there is no safe argument-free call to probe with.`,
    );
  }
  out.push("");
  // The action to suggest depends on what the provider actually has. Telling a reader of an
  // ALL-WRITE provider (Slack, say) to "choose a read action" sends them looking for something
  // that doesn't exist — and testing a write here really does post, so say so.
  const testAction = probe
    ? ` and the *${probe.label}* action`
    : allWrite
      ? ", choose an action and fill its fields"
      : ", choose a read action and fill its ids";
  out.push(
    `Either way, the definitive check is **single-node Test** on the canvas: drop a **${p.label}** node, pick this connection${testAction}, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.`,
  );
  if (!probe && allWrite) {
    out.push("");
    out.push(
      `Every ${p.label} action writes, so this test performs a **real** action on your account — send to a scratch channel or test record, not a live one.`,
    );
  }
  out.push("");
  if (prose.verifyExample?.length) {
    out.push("A concrete first run:");
    out.push("");
    prose.verifyExample.forEach((s, i) => out.push(`${i + 1}. ${s}`));
    out.push("");
  }
  if (!opts.liveVerified) {
    out.push(
      "> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.",
    );
    out.push("");
  }

  // ---- Actions (GENERATED) ---------------------------------------------------------------
  out.push("## Actions");
  out.push("");
  out.push(
    "| Action | Method | Endpoint | Required fields | Optional fields |",
  );
  out.push("| --- | --- | --- | --- | --- |");
  for (const a of actions) out.push(actionRow(a));
  out.push("");
  out.push(
    "Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.",
  );
  if (writes.length) {
    out.push("");
    out.push(
      `The ${writes.length} write action${
        writes.length === 1 ? "" : "s"
      } run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.`,
    );
  }
  out.push("");

  // Flat-field → nested-payload mapping, straight from each field's `bodyPath`. Worth emitting
  // because the config panel shows a FLAT field list while the provider wants a nested JSON body:
  // without this, `projectKey` looks like it should be a top-level key and nobody can tell what the
  // node actually sends. Generated, so it stays right when the catalog's shapes change.
  const mapped = actions
    .map((a) => ({
      action: a,
      // Identity mappings (`body` → `body`) are noise — only show where the shape actually changes.
      fields: (a.fields ?? []).filter(
        (f) => f.bodyPath && f.bodyPath !== f.key && f.const === undefined,
      ),
    }))
    .filter((m) => m.fields.length > 0);
  if (mapped.length) {
    out.push("### Flat fields → nested payload");
    out.push("");
    out.push(
      "You fill in flat fields; the node assembles the nested body the API expects.",
    );
    out.push("");
    for (const m of mapped) {
      out.push(
        `- **${m.action.label}**: ${m.fields
          .map((f) => `\`${f.key}\` → \`${f.bodyPath}\``)
          .join(", ")}`,
      );
    }
    out.push("");
  }

  // ---- Output (GENERATED, uniform) -------------------------------------------------------
  out.push("## Output");
  out.push("");
  out.push(
    "`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.",
  );
  out.push("");

  // ---- Gotchas (PROSE) -------------------------------------------------------------------
  if (prose.gotchas?.length) {
    out.push("## Gotchas");
    out.push("");
    for (const g of prose.gotchas) out.push(`- ${g}`);
    out.push("");
  }

  // ---- Troubleshooting (GENERATED, tailored by scheme/baseUrl) ---------------------------
  out.push("## Troubleshooting");
  out.push("");
  out.push("| Symptom | Most likely cause |");
  out.push("| --- | --- |");
  out.push(
    `| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. ${
      auth.id === "basic"
        ? "Check you pasted the full `user:secret` pair and not just the secret."
        : auth.id === "custom-header"
          ? "Paste only the raw token — Naary adds the header and any prefix itself."
          : "Paste only the token, with no `Bearer ` prefix of your own."
    } |`,
  );
  if (needsServerUrl(p)) {
    out.push(
      // "or version segment" used to be here and was withdrawn (#1109): a missing SEGMENT does
      // 404, but an out-of-date API VERSION is the one Server-URL mistake that does not — Shopify
      // falls forward and answers 200 as a version you did not pick. Naming the version here made
      // this row contradict the provider's own gotcha two sections above it. Where the version is
      // the risk, `serverUrlFailure` says so on the Server URL line instead.
      "| **404 on a call that should work** | The Server URL is wrong. Re-read the format above — a missing or mistyped path segment produces a 404, not a helpful error. |",
    );
  }
  out.push(
    "| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |",
  );
  out.push(
    "| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |",
  );
  out.push(
    "| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |",
  );
  out.push("");
  out.push("---");
  out.push("");
  out.push(
    "Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).",
  );
  out.push("");

  return out.join("\n");
}
