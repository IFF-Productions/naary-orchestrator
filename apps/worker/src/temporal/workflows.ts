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
// Kafka scheduled drain (#1086 slice 2): one run per message, started as ABANDONed children with
// a workflowId derived from (topic, partition, offset) so a redelivery is deduped by Temporal.
// Registered by the name "kafkaDrain".
export { kafkaDrain, kafkaRunId } from "./workflow/kafka-drain";
export type { KafkaDrainInput, KafkaDrainResult } from "./workflow/kafka-drain";
// MQTT scheduled drain (#1086 slice 3b): one run per message over a PERSISTENT broker session.
// Registered by the name "mqttDrain". Its run ids are unique-per-drain, NOT a dedupe key — MQTT
// has no stable message identity to build one from (see mqttRunId). Registered by the name
// "mqttDrain".
export {
  mqttDrain,
  mqttRunId,
  mqttSessionClientId,
} from "./workflow/mqtt-drain";
export type { MqttDrainInput, MqttDrainResult } from "./workflow/mqtt-drain";
