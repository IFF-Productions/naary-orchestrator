/**
 * GUARD: a setting the code reads must be a setting the deployed container can actually receive.
 *
 * Compose hands a container ONLY the variables that service names in its own `environment:`
 * block. Nothing warns you otherwise — the code reads `undefined`, takes its default, and the
 * operator who set the value in `/opt/naary/.env` has no way to tell. We have shipped this bug
 * three times:
 *
 *   #862  CODE_AGENT_WRITE_ENABLED — the worker read it; no compose file named it, so codeAgent
 *         write mode could not be enabled in production at all.
 *   #594  CODE_AGENT_SANDBOX_READ — the opt-in for the SANDBOXED read path, named nowhere in
 *         `deploy/`, so the isolation that closed a security issue was never reachable in prod.
 *   #939  digest pinning — the runner compared against hardcoded `:latest` tags while being
 *         passed the operator's configured image, so following our own documented advice failed.
 *
 * So this test diffs the two sides mechanically:
 *
 *   READS     every `process.env.X` / `env.X` in the SOURCE a service runs — its own app plus
 *             every `@naary/*` package it depends on (a package consumed by both api and worker
 *             must be reachable from BOTH worker pools; a var declared on `worker` only is #862
 *             verbatim).
 *   RECEIVES  every key named under that service's `environment:` across the four compose files
 *             CD actually layers (`.github/workflows/deploy.yml`, the `FILES=` line), with the
 *             `<<: *backend-env` anchor expanded.
 *
 * A var in READS and not in RECEIVES fails, unless it is in OPT_OUTS below with a reason. The
 * opt-out list is also checked in reverse: an entry whose var is no longer read anywhere fails
 * too, so the list cannot quietly rot into a blanket suppression.
 *
 * WHY IT LIVES HERE: vitest only collects `apps/**‍/test` and `packages/**‍/test` (vitest.config.ts),
 * and this app's `test/` is already where the repo keeps source-scanning guards
 * (`workflow-bundle.spec.ts`). It scans the whole repo, not just the worker.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");

// ---------------------------------------------------------------------------
// what each deployed service runs
// ---------------------------------------------------------------------------

/**
 * The compose files CD layers, in order — kept in step with the `FILES=` line in
 * `.github/workflows/deploy.yml`. Dev/e2e/flagsmith overlays are deliberately NOT here: they
 * are not what production receives.
 */
const PROD_COMPOSE_FILES = [
  "docker-compose.yml",
  "deploy/docker-compose.prod.yml",
  "deploy/docker-compose.neon.yml",
  "deploy/docker-compose.ghcr.yml",
];

/**
 * Compose service → the app whose code it runs. The `@naary/*` packages are derived from that
 * app's package.json (below) rather than listed, so a new shared package is covered the day it
 * is added — the failure mode we are guarding against is exactly "nobody remembered to update
 * the other list".
 *
 * `migrate` runs `prisma migrate deploy` (no app code of ours) and `web` is a static bundle
 * whose config is BUILD-time, so both are handled separately from this map.
 */
const SERVICE_APPS: Record<string, string> = {
  api: "apps/api",
  worker: "apps/worker",
  "worker-heavy": "apps/worker",
  "sandbox-runner": "apps/sandbox-runner",
};

/**
 * Reads the scanner CANNOT see, because the variable name is computed. Listed by hand, with the
 * file that computes them — and `no new computed reads appear` below fails if a fifth site shows
 * up, so this blind spot announces itself instead of growing silently.
 */
const DYNAMIC_READS: Record<string, string[]> = {
  // worker-tuning.ts passes these literals to positiveIntEnv(name, env)
  "apps/worker/src/worker-tuning.ts": [
    "WORKER_MAX_ACTIVITIES",
    "WORKER_MAX_WORKFLOW_TASKS",
    "WORKER_MAX_CACHED_WORKFLOWS",
  ],
  // config.ts: env[`SANDBOX_IMAGE_${tool.toUpperCase()}`] over the closed SANDBOX_TOOLS set
  "apps/sandbox-runner/src/config.ts": [
    "SANDBOX_IMAGE_CLAUDE",
    "SANDBOX_IMAGE_CURSOR",
    "SANDBOX_IMAGE_COPILOT",
    "SANDBOX_IMAGE_GEMINI",
  ],
};

/**
 * The same blind spot, but where the computed name depends on WHICH SERVICE is running the code
 * rather than on the file. `packages/observability` reads `env[componentDsnVar(component)]`, and
 * the component is fixed per process — so the api reads only SENTRY_DSN_API and a worker only
 * SENTRY_DSN_WORKER. Attributing both to both would demand each service declare the other's DSN.
 */
const SERVICE_DYNAMIC_READS: Record<string, string[]> = {
  api: ["SENTRY_DSN_API"],
  worker: ["SENTRY_DSN_WORKER"],
  "worker-heavy": ["SENTRY_DSN_WORKER"],
  // the sandbox-runner is deliberately NOT instrumented (it holds the Docker socket and is kept
  // dependency-minimal — docs/design/CLAUDE-CODE-NODE.md §8b.1), so it reads no Sentry DSN.
  "sandbox-runner": [],
};

/** Files allowed to index `env[...]` with a computed key — the DYNAMIC_READS sites, plus the
 *  generic `positiveIntEnv(name, env)` helper the first of them calls, plus the per-component
 *  Sentry DSN accessor covered by SERVICE_DYNAMIC_READS. */
const DYNAMIC_READ_FILES = new Set([
  ...Object.keys(DYNAMIC_READS),
  "apps/worker/src/config.ts",
  "packages/observability/src/config.ts",
]);

/** Supplied by the container runtime / the OS, never by compose. */
const RUNTIME_PROVIDED = new Set(["PATH", "HOME", "NODE_ENV", "PWD", "TZ"]);

/**
 * Read by a service, absent from its prod `environment:` — ON PURPOSE. Each entry must say why,
 * and each is re-checked: an entry for a var nothing reads any more fails the suite.
 */
const OPT_OUTS: { service: string; name: string; reason: string }[] = [
  {
    service: "worker",
    name: "FIRESTORE_EMULATOR_HOST",
    reason:
      "Deliberate, and wiring it into prod compose would DEFEAT it: FIRESTORE_EMULATOR_HOST points the firestore nodes at a LOCAL Firestore emulator for tests. It is refused unless it names a loopback host (see packages/firestore/src/emulator.ts), so it can never redirect production traffic — but it must also never appear in the prod stack, where any value at all would be wrong. Unset in production is the correct state.",
  },
  {
    service: "worker-heavy",
    name: "FIRESTORE_EMULATOR_HOST",
    reason: "Same as `worker` — it runs the same image.",
  },
  {
    service: "worker",
    name: "CORS_ORIGINS",
    reason:
      "Deliberate: the worker is given APP_BASE_URL explicitly (#674) precisely so its documented " +
      "CORS_ORIGINS fallback never has to fire. CORS is an api-only concern.",
  },
  {
    service: "worker-heavy",
    name: "CORS_ORIGINS",
    reason:
      "Same as `worker` — it runs the same image and is given the same explicit APP_BASE_URL.",
  },
  {
    service: "worker",
    name: "WORKER_TASK_QUEUE",
    reason:
      "Service IDENTITY, not operator config: `worker` polls the default queue and `worker-heavy` " +
      "sets orchestrator-heavy. Making the default pool's queue settable would let one .env value " +
      "point both pools at the same queue and strand every codeAgent run.",
  },
  {
    service: "worker",
    name: "APP_VERSION",
    reason:
      "Second-choice fallback in workerVersion(); SENTRY_RELEASE wins and CD always sets it to the " +
      "deployed tag. APP_VERSION is compose-level (the image tag), never meant to be in-container.",
  },
  {
    service: "worker-heavy",
    name: "APP_VERSION",
    reason:
      "Same as `worker` — SENTRY_RELEASE is set by CD and wins over this fallback in workerVersion().",
  },
  {
    service: "api",
    name: "MCP_REGISTRY_URL",
    reason:
      "Override for the PUBLIC MCP registry URL, which has a code default beside the fetch that " +
      "uses it. Absence is the intended production posture, not a broken knob.",
  },
  {
    service: "sandbox-runner",
    name: "PORT",
    reason:
      "Must stay 8099: the service healthcheck and SANDBOX_RUNNER_URL's default both hardcode it. " +
      "Declaring it would let an operator set a value that breaks both — the knob is inert BY DESIGN.",
  },
  {
    service: "sandbox-runner",
    name: "SANDBOX_IMAGE",
    reason:
      "Pre-#680 single-image alias kept only so an old deploy still boots; superseded by the four " +
      "SANDBOX_IMAGE_<TOOL> vars, which CD sets digest-pinned. Reviving it would reintroduce the " +
      "mutable-tag path the digest pin exists to close.",
  },
];

// ---------------------------------------------------------------------------
// source scanning
// ---------------------------------------------------------------------------

/** Strip comments so a variable NAMED in prose (`export const FOO = process.env.FOO` in a doc
 *  block) is not counted as a read. Keeps `//` inside `http://` by requiring a non-`:` before it. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === "generated") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * Every env var read in a source tree. Matches the four static forms the codebase uses —
 * `process.env.X`, `process.env["X"]`, and the injectable-env accessor shape `env.X` / `env["X"]`
 * that docs/design/CONFIG-CENTRALIZATION.md standardised on — plus this tree's DYNAMIC_READS.
 */
function readsIn(rootRel: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const add = (name: string, file: string) => {
    if (RUNTIME_PROVIDED.has(name)) return;
    if (!found.has(name)) found.set(name, new Set());
    found.get(name)!.add(file);
  };
  const re =
    /(?:process\.)?\benv(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*["'`]([A-Z][A-Z0-9_]{2,})["'`]\s*\])/g;
  for (const abs of walk(join(REPO, rootRel, "src"))) {
    const rel = relative(REPO, abs).split("\\").join("/");
    const src = stripComments(readFileSync(abs, "utf8"));
    for (const m of src.matchAll(re)) add((m[1] ?? m[2])!, rel);
    for (const name of DYNAMIC_READS[rel] ?? []) add(name, rel);
  }
  return found;
}

/** The `@naary/*` workspace packages an app depends on (transitively). */
function packageRootsFor(appRel: string): string[] {
  const pkg = (rel: string) =>
    JSON.parse(readFileSync(join(REPO, rel, "package.json"), "utf8"));
  const deps = (p: { dependencies?: object; devDependencies?: object }) =>
    Object.keys({ ...p.dependencies, ...p.devDependencies }).filter((d) =>
      d.startsWith("@naary/"),
    );
  const seen = new Set<string>();
  const stack = deps(pkg(appRel));
  while (stack.length > 0) {
    const d = stack.pop()!;
    if (seen.has(d)) continue;
    seen.add(d);
    try {
      stack.push(...deps(pkg(`packages/${d.slice("@naary/".length)}`)));
    } catch {
      /* not a workspace package */
    }
  }
  return [...seen].map((d) => `packages/${d.slice("@naary/".length)}`);
}

/** Every var the given service's process can read, → the files that read it. */
function readsForService(service: string): Map<string, Set<string>> {
  const appRel = SERVICE_APPS[service]!;
  const merged = new Map<string, Set<string>>();
  for (const root of [appRel, ...packageRootsFor(appRel)]) {
    for (const [name, files] of readsIn(root)) {
      if (!merged.has(name)) merged.set(name, new Set());
      for (const f of files) merged.get(name)!.add(f);
    }
  }
  for (const name of SERVICE_DYNAMIC_READS[service] ?? []) {
    if (!merged.has(name)) merged.set(name, new Set());
    merged.get(name)!.add("packages/observability/src/config.ts");
  }
  return merged;
}

// ---------------------------------------------------------------------------
// compose parsing
// ---------------------------------------------------------------------------

interface ComposeDoc {
  /** anchor name → the keys of the mapping it anchors */
  anchors: Map<string, Set<string>>;
  /** service → env keys named directly (anchor merges recorded separately) */
  serviceEnv: Map<string, { keys: Set<string>; merges: string[] }>;
  /** service → build-arg keys (build-time config, e.g. the web bundle's VITE_*) */
  serviceBuildArgs: Map<string, Set<string>>;
}

/**
 * A deliberately small YAML reader for the ONE shape we need: which KEYS appear under a
 * service's `environment:` / `build.args:`. It does not evaluate `${...}`, and it ignores the
 * `!override` / `!reset` compose tags — none of which changes which keys are named.
 *
 * Hand-rolled rather than a YAML dependency because it must be STRICT in the direction that
 * matters: anything it cannot account for inside an `environment:` block throws, so the guard
 * can never quietly under-report a service's variables and pass for the wrong reason.
 */
function parseCompose(text: string): ComposeDoc {
  const doc: ComposeDoc = {
    anchors: new Map(),
    serviceEnv: new Map(),
    serviceBuildArgs: new Map(),
  };
  const stack: { indent: number; key: string }[] = [];
  const anchorAt = new Map<string, string>(); // path → anchor name

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const body = raw.trim().replace(/\s+#.*$/, "");

    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop();
    }
    const parentPath = stack.map((s) => s.key).join(".");

    // sequence item — only meaningful to us as compose's list form of `environment:`
    if (body.startsWith("- ")) {
      if (
        parentPath.startsWith("services.") &&
        parentPath.endsWith(".environment")
      ) {
        const service = parentPath.split(".")[1]!;
        const name = body
          .slice(2)
          .trim()
          .replace(/^["']|["']$/g, "")
          .split("=")[0]!;
        env(doc, service).keys.add(name);
      }
      continue;
    }

    const m = /^([^:]+):(.*)$/.exec(body);
    if (m === null) {
      if (
        parentPath.startsWith("services.") &&
        parentPath.endsWith(".environment")
      ) {
        throw new Error(
          `deploy-env guard: unparsed line inside an environment block (line ${i + 1}): ${raw}`,
        );
      }
      continue;
    }
    const key = m[1]!.trim().replace(/^["']|["']$/g, "");
    const rest = m[2]!.trim();
    const path = parentPath === "" ? key : `${parentPath}.${key}`;

    // `<<: *backend-env` — a merge of a named anchor into this mapping
    if (key === "<<") {
      const anchor = /^\*(\S+)/.exec(rest)?.[1];
      if (anchor === undefined) {
        throw new Error(
          `deploy-env guard: unrecognised merge on line ${i + 1}: ${raw}`,
        );
      }
      if (
        parentPath.startsWith("services.") &&
        parentPath.endsWith(".environment")
      ) {
        env(doc, parentPath.split(".")[1]!).merges.push(anchor);
      }
      continue;
    }

    // `x-backend-env: &backend-env` — remember which path this anchor names
    const anchorName = /^&(\S+)/.exec(rest)?.[1];
    if (anchorName !== undefined) {
      anchorAt.set(path, anchorName);
      doc.anchors.set(anchorName, new Set());
    }

    if (parentPath.startsWith("services.")) {
      const parts = parentPath.split(".");
      const service = parts[1]!;
      if (parts.length === 3 && parts[2] === "environment") {
        env(doc, service).keys.add(key);
      } else if (
        parts.length === 4 &&
        parts[2] === "build" &&
        parts[3] === "args"
      ) {
        if (!doc.serviceBuildArgs.has(service)) {
          doc.serviceBuildArgs.set(service, new Set());
        }
        doc.serviceBuildArgs.get(service)!.add(key);
      }
    }

    const ownerAnchor = anchorAt.get(parentPath);
    if (ownerAnchor !== undefined) doc.anchors.get(ownerAnchor)!.add(key);

    stack.push({ indent, key });
  }
  return doc;
}

function env(doc: ComposeDoc, service: string) {
  if (!doc.serviceEnv.has(service)) {
    doc.serviceEnv.set(service, { keys: new Set(), merges: [] });
  }
  return doc.serviceEnv.get(service)!;
}

/** Union, across every prod compose file, of the env keys a service is given. */
function receivesByService(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const buildArgs = new Map<string, Set<string>>();
  const anchors = new Map<string, Set<string>>();
  const pending: { service: string; merges: string[] }[] = [];

  for (const file of PROD_COMPOSE_FILES) {
    const doc = parseCompose(readFileSync(join(REPO, file), "utf8"));
    for (const [name, keys] of doc.anchors) anchors.set(name, keys);
    for (const [service, { keys, merges }] of doc.serviceEnv) {
      if (!out.has(service)) out.set(service, new Set());
      for (const k of keys) out.get(service)!.add(k);
      if (merges.length > 0) pending.push({ service, merges });
    }
    for (const [service, args] of doc.serviceBuildArgs) {
      if (!buildArgs.has(service)) buildArgs.set(service, new Set());
      for (const a of args) buildArgs.get(service)!.add(a);
    }
  }
  for (const { service, merges } of pending) {
    for (const anchor of merges) {
      const keys = anchors.get(anchor);
      if (keys === undefined) {
        throw new Error(`deploy-env guard: merge of unknown anchor *${anchor}`);
      }
      for (const k of keys) out.get(service)!.add(k);
    }
  }
  for (const [service, args] of buildArgs) {
    out.set(`${service}:build`, args);
  }
  return out;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("prod deploy: every setting the code reads must reach the container", () => {
  const receives = receivesByService();

  it("parses the prod compose stack (the guard is worthless if this silently finds nothing)", () => {
    // The anchor merge is the whole reason a naive parser under-reports: without it, `api`
    // would look like it receives 4 keys instead of ~35.
    // `web` is absent on purpose: it has no `environment:` at all, only build args (below).
    for (const service of [...Object.keys(SERVICE_APPS), "migrate"]) {
      expect(
        receives.has(service),
        `service '${service}' missing from compose`,
      ).toBe(true);
    }
    expect(receives.get("api")!.has("DATABASE_URL")).toBe(true); // via <<: *backend-env
    expect(receives.get("api")!.size).toBeGreaterThan(30);
    expect(receives.get("web:build")!.has("VITE_FIREBASE_API_KEY")).toBe(true);
  });

  for (const service of Object.keys(SERVICE_APPS)) {
    it(`${service}: reads nothing the prod compose stack doesn't give it`, () => {
      const declared = receives.get(service)!;
      const allowed = new Set(
        OPT_OUTS.filter((o) => o.service === service).map((o) => o.name),
      );
      const gaps: string[] = [];
      for (const [name, files] of [...readsForService(service)].sort()) {
        if (declared.has(name) || allowed.has(name)) continue;
        gaps.push(`  ${name} — read by ${[...files].sort().join(", ")}`);
      }
      expect(
        gaps.length,
        `service '${service}' reads ${gaps.length} variable(s) that no compose file declares for it,\n` +
          `so setting them in /opt/naary/.env reaches nothing (see #862):\n${gaps.join("\n")}\n\n` +
          `Fix: declare each on '${service}' in docker-compose.yml (or deploy/docker-compose.prod.yml)\n` +
          `and document it in deploy/.env.prod.example — or add it to OPT_OUTS in this file with a reason.`,
      ).toBe(0);
    });
  }

  it("web: every VITE_* the SPA reads survives the whole build-arg chain", () => {
    // The SPA has no runtime env — Vite INLINES import.meta.env at build time, so the
    // reachability question is about build args. All FOUR links have to hold, and only the
    // last one actually puts the value in the bundle:
    //   compose `build.args`  →  deploy.yml `build-args:` (the CI image is what prod runs)
    //   →  `ARG` in the Dockerfile's BUILD stage (docker SILENTLY DROPS a --build-arg the
    //      Dockerfile never declares, and ARG does not cross stage boundaries)
    //   →  `ENV` in that same stage, which is what `vite build` reads.
    // Checking only the first two would let a new VITE_* look wired and bake in `undefined`.
    const declared = new Set(receives.get("web:build")!);
    const ciBuildArgs = readFileSync(
      join(REPO, ".github/workflows/deploy.yml"),
      "utf8",
    );
    const dockerfile = readFileSync(join(REPO, "apps/web/Dockerfile"), "utf8");
    // Uses the SAME matcher as the backend scan, NOT a `import\.meta\.env\.VITE_` regex: the SPA
    // also reads through an injected env object (`env.VITE_FIREBASE_APPCHECK_SITE_KEY` in
    // lib/app-check.ts, the same test seam the server code uses), and a literal-only regex missed
    // App Check entirely — verified by deleting its ARG line and watching this test stay green.
    const read = [...readsIn("apps/web").keys()].filter((n) =>
      n.startsWith("VITE_"),
    );
    expect(read.length).toBeGreaterThan(10);
    for (const name of read.sort()) {
      expect(
        declared.has(name),
        `${name} is read by the SPA but is not a build arg of \`web\``,
      ).toBe(true);
      expect(
        ciBuildArgs.includes(`${name}=`),
        `${name} is read by the SPA but deploy.yml never passes it — the CI-built image (the one prod runs) would bake in undefined`,
      ).toBe(true);
      expect(
        new RegExp(`^ARG ${name}\\s*$`, "m").test(dockerfile),
        `${name} is passed as a build arg but apps/web/Dockerfile has no matching \`ARG ${name}\` — docker DISCARDS a --build-arg the Dockerfile does not declare, silently`,
      ).toBe(true);
      expect(
        // matches both the `ENV NAME=$NAME \` head and the indented continuation lines
        new RegExp(
          `^\\s*(?:ENV\\s+)?${name}=\\$${name}\\s*\\\\?\\s*$`,
          "m",
        ).test(dockerfile),
        `${name} has an ARG but is never promoted to ENV in the build stage, so \`vite build\` cannot see it`,
      ).toBe(true);
    }
  });

  it("no new computed env reads appear (the scanner cannot see them)", () => {
    const offenders: string[] = [];
    for (const root of ["apps", "packages"]) {
      for (const abs of walk(join(REPO, root))) {
        const rel = relative(REPO, abs).split("\\").join("/");
        if (!rel.includes("/src/") || DYNAMIC_READ_FILES.has(rel)) continue;
        if (
          /(?:process\.)?\benv\[/.test(stripComments(readFileSync(abs, "utf8")))
        ) {
          offenders.push(rel);
        }
      }
    }
    expect(
      offenders,
      "these files index the environment with a COMPUTED key, which this guard's regex cannot see. " +
        "Add the variable names to DYNAMIC_READS (and the file to DYNAMIC_READ_FILES) so they are " +
        "still diffed against compose.",
    ).toEqual([]);
  });

  it("no stale OPT_OUTS (an entry for a var nobody reads any more)", () => {
    const stale = OPT_OUTS.filter(
      (o) => !readsForService(o.service).has(o.name),
    ).map((o) => `${o.service}/${o.name}`);
    expect(
      stale,
      "these opt-outs no longer correspond to a real read — delete them, or the list becomes a " +
        "blanket suppression nobody dares touch.",
    ).toEqual([]);
    for (const o of OPT_OUTS) {
      expect(
        o.reason.length,
        `${o.service}/${o.name} needs a reason`,
      ).toBeGreaterThan(40);
    }
  });
});
