// Temporal WORKFLOW BUNDLE ENTRY — worker.ts (`workflowsPath`) and the e2e test
// Workers point at THIS file, and Temporal registers workflows by this module's
// exported function names. The interpreter now lives in ./workflow/* (split
// verbatim, zero behavior change); this module only re-exports the workflow
// functions and their public types, so the registered names ("runGraph",
// "chatSession") and the import surface for tests are unchanged.
//
// Everything reachable from here is deterministic sandbox code (CLAUDE.md Tier-1):
// no I/O, no clock, no randomness — side effects live behind the activity proxies
// in ./workflow/proxies.ts, and the activities import stays TYPE-ONLY.
export { runGraph } from "./workflow/run-graph";
export type {
  RunGraphResult,
  RunGraphCtx,
  ResumeState,
} from "./workflow/types";
export { chatSession } from "./workflow/chat-session";
export type { ChatSessionInput } from "./workflow/chat-session";
// Eval batch (#575): a golden dataset run as an ordinary Temporal execution, launching one CHILD
// runGraph per case. Registered by the name "evalRun".
export {
  evalRun,
  EVAL_CONCURRENCY,
  EVAL_CASE_TIMEOUT_MS,
} from "./workflow/eval-run";
export type { EvalRunInput, EvalRunResult } from "./workflow/eval-run";
