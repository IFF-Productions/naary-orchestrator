/**
 * TYPED-DSL Phase 2·2 — a runtime-free typed accessor for node config.
 *
 * The interpreter reads a node's config as a resolved `Record<string, unknown>` (templates already
 * applied) and needs it typed per node kind. `asNodeConfig(cfg, "httpRequest")` centralizes that
 * single unavoidable cast and sources the type from the registry (`NodeConfigMap`), replacing 34
 * scattered `cfg as unknown as XNodeConfig` casts in workflows.ts.
 *
 * Why a cast at all: workflow code is deterministic and cannot run zod (Tier-1 rule 2), and a
 * template-resolved Record has no static type. The REAL shape guarantee comes from the Phase-3
 * save-time validation (`validateGraphConfigs`), so the worker trusts the config here.
 *
 * Zod-free by construction: the registry config types are pulled in with `import type` (erased at
 * compile), so this module — and anything the worker imports through the package index — carries no
 * zod into the deterministic workflow bundle.
 */
import type { NodeType } from "./types";
import type {
  AgentConfig,
  AggregateConfig,
  CodeAgentConfig,
  CodeConfig,
  CompareDatasetsConfig,
  CsvConfig,
  DateTimeConfig,
  EncodeConfig,
  ExecuteSubWorkflowConfig,
  FilterConfig,
  ForEachConfig,
  HashConfig,
  HmacConfig,
  HtmlExtractConfig,
  MarkdownConfig,
  VectorUpsertConfig,
  VectorQueryConfig,
  SplitOutConfig,
  LoopEndConfig,
  GraphQLConfig,
  HttpRequestConfig,
  HumanApprovalConfig,
  IfConfig,
  JsonConfig,
  JwtConfig,
  ListOpsConfig,
  McpToolConfig,
  IntegrationConfig,
  MergeConfig,
  FormTriggerConfig,
  ChatTriggerConfig,
  NumberConfig,
  PollTriggerConfig,
  RandomConfig,
  RenameKeysConfig,
  RespondToWebhookConfig,
  RssReadConfig,
  ScheduleTriggerConfig,
  SendEmailConfig,
  SetConfig,
  SqlExecConfig,
  SqlQueryConfig,
  StartConfig,
  StopAndErrorConfig,
  SwitchConfig,
  TextConfig,
  TotpConfig,
  WaitConfig,
  XmlConfig,
} from "./registry";

/** node type → its config shape (registry-derived). Config-less entry/exit nodes map to an open
 *  record. Exhaustiveness is enforced by `_mapCoversAllNodes` below. */
export interface NodeConfigMap {
  start: StartConfig;
  webhookTrigger: Record<string, unknown>;
  errorTrigger: Record<string, unknown>;
  pollTrigger: PollTriggerConfig;
  scheduleTrigger: ScheduleTriggerConfig;
  formTrigger: FormTriggerConfig;
  chatTrigger: ChatTriggerConfig;
  agent: AgentConfig;
  codeAgent: CodeAgentConfig;
  mcpTool: McpToolConfig;
  integration: IntegrationConfig;
  httpRequest: HttpRequestConfig;
  graphQL: GraphQLConfig;
  sqlQuery: SqlQueryConfig;
  sqlExec: SqlExecConfig;
  set: SetConfig;
  renameKeys: RenameKeysConfig;
  text: TextConfig;
  filter: FilterConfig;
  aggregate: AggregateConfig;
  listOps: ListOpsConfig;
  compareDatasets: CompareDatasetsConfig;
  xml: XmlConfig;
  htmlExtract: HtmlExtractConfig;
  markdown: MarkdownConfig;
  vectorUpsert: VectorUpsertConfig;
  vectorQuery: VectorQueryConfig;
  noOp: Record<string, unknown>;
  splitOut: SplitOutConfig;
  loopEnd: LoopEndConfig;
  csv: CsvConfig;
  json: JsonConfig;
  number: NumberConfig;
  encode: EncodeConfig;
  dateTime: DateTimeConfig;
  merge: MergeConfig;
  if: IfConfig;
  switch: SwitchConfig;
  hmac: HmacConfig;
  jwt: JwtConfig;
  totp: TotpConfig;
  hash: HashConfig;
  random: RandomConfig;
  sendEmail: SendEmailConfig;
  rssRead: RssReadConfig;
  executeSubWorkflow: ExecuteSubWorkflowConfig;
  forEach: ForEachConfig;
  wait: WaitConfig;
  stopAndError: StopAndErrorConfig;
  respondToWebhook: RespondToWebhookConfig;
  code: CodeConfig;
  humanApproval: HumanApprovalConfig;
  end: Record<string, unknown>;
}

// Build fails if a NodeType is missing a NodeConfigMap entry (keeps the map exhaustive).
type _mapCoversAllNodes = NodeType extends keyof NodeConfigMap ? true : never;
const _mapCheck: _mapCoversAllNodes = true;
void _mapCheck;

export type ConfigForType<T extends NodeType> = NodeConfigMap[T];

/** Narrow a resolved config Record to its node type's shape. Centralizes the one cast the
 *  deterministic interpreter can't avoid (see file header). `_type` is type-level only. */
export function asNodeConfig<T extends NodeType>(
  cfg: Record<string, unknown>,
  _type: T,
): ConfigForType<T> {
  return cfg as unknown as ConfigForType<T>;
}
