/**
 * Workflow entrypoint for the self-healing task queue — the module Temporal bundles into its V8
 * isolate.
 *
 * Separate from `heal-workflow.ts` for the same reason the main worker has `temporal/workflows.ts`:
 * the bundler compiles EVERYTHING reachable from here into the deterministic sandbox, so this file
 * re-exports the workflow and nothing else. Importing a Nest service — or anything that reaches
 * one — would drag the whole API into a sandbox that forbids I/O.
 */
export { healRun } from "./heal-workflow";
