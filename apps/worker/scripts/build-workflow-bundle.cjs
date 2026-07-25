// Precompile the Temporal workflow bundle at IMAGE-BUILD time.
//
// WHY: the worker otherwise bundles its workflow code with webpack IN-PROCESS at boot
// (Worker.create({ workflowsPath })). That ~4.3MB bundle build spikes RSS by several
// hundred MB — which OOM-killed the new worker mid-boot during docker-rollout's 2x-scale
// rolling deploy on the 8GB box (fix #676: it died before /metrics bound, so the health
// gate never passed and the deploy reverted). Building the bundle HERE moves that spike
// to the CI build runner (ample RAM) and off the production box entirely; the worker then
// loads the finished bundle via Worker.create({ workflowBundle: { codePath } }) with no
// webpack at startup (also a faster, more predictable boot).
//
// The Temporal bundler carries its OWN swc-loader for .ts (worker SDK bundler.js), so this
// runs as plain node — no @swc/register hook needed. Runs AFTER `tsc -b` in the Dockerfile
// so the @naary/* workspace deps the workflow imports are already built to dist/.
const fs = require("node:fs");
const path = require("node:path");
const { bundleWorkflowCode } = require("@temporalio/worker");

const workerRoot = path.resolve(__dirname, "..");
// Mirror worker.ts's runtime resolution EXACTLY (require.resolve("./temporal/workflows")
// and require.resolve("./temporal/workflow-trace-interceptors")).
const workflowsPath = path.join(workerRoot, "src", "temporal", "workflows.ts");
const interceptorPath = path.join(
  workerRoot,
  "src",
  "temporal",
  "workflow-trace-interceptors.ts",
);
const outPath = path.join(workerRoot, "dist", "workflow-bundle.js");

async function main() {
  const { code } = await bundleWorkflowCode({
    workflowsPath,
    // CRITICAL: with a prebuilt bundle, Worker.create's `interceptors.workflowModules`
    // are IGNORED (Temporal warns) — the workflow-side interceptors must be baked in HERE
    // or Sentry's cross-workflow tracing silently breaks in prod. This is the same module
    // worker.ts passes to Worker.create today, so the bundle is behaviorally identical.
    workflowInterceptorModules: [interceptorPath],
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, code);
  console.log(
    `[build-workflow-bundle] wrote ${outPath} (${(code.length / 1e6).toFixed(2)} MB)`,
  );
}

main().catch((err) => {
  console.error("[build-workflow-bundle] failed:", err);
  process.exit(1);
});
