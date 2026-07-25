import type { ArgBinding } from "./core";

export interface McpToolNodeConfig {
  connectionId: string;
  tool: string;
  /** Static arguments, merged under any resolved bindings. */
  arguments?: Record<string, unknown>;
  /** argName → upstream output binding; overrides a static key of the same name. */
  argumentBindings?: Record<string, ArgBinding>;
  /** Flat per-call cost metered into the run budget (Slice #6 / Arch§4.6). */
  costUsd?: number;
}

/**
 * textToSpeech node (#689). Synthesizes `text` into an audio object via a BYOK TTS provider.
 *
 * NOT a catalog integration: the declarative integration catalog is JSON-request → JSON-response
 * (`integration.ts` JSON-stringifies the body and JSON-parses the reply), and TTS returns BINARY
 * audio — so it needs its own node type + activity.
 *
 * The audio NEVER rides Temporal history (CLAUDE.md *Payloads*): the activity writes the bytes to
 * object storage and the node output carries only a small `{ __objectRef, contentType, bytes }`
 * reference plus metadata. Credentials come from the tenant's BYOK provider slot, fetched IN the
 * activity (Tier-1 rule 4) — never from config.
 */
export interface TextToSpeechNodeConfig {
  /** TTS driver. Defaults to "openai". */
  provider?: "openai";
  /** The text to speak. `{{ nodeId.path }}` templating is resolved before the activity. */
  text?: string;
  /** Upstream binding whose resolved value replaces `text` (non-strings are stringified). */
  textBinding?: ArgBinding;
  /** Provider voice id (e.g. OpenAI "alloy"). Defaults to the driver's default voice. */
  voice?: string;
  /** Provider model id (e.g. "tts-1"). Defaults to the driver's default model. */
  model?: string;
  /** Audio container/codec. Defaults to "mp3". */
  format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  /** Playback-rate multiplier passed to the provider (OpenAI accepts 0.25–4.0). */
  speed?: number;
  /** Overall wall-clock budget for the synthesis call (ms). */
  timeoutMs?: number;
  /** Flat fallback cost metered if character-derived pricing is unavailable (never zero). */
  costUsd?: number;
}

/**
 * codeAgent node (design docs/design/CLAUDE-CODE-NODE.md). Runs an agentic coding CLI
 * (Claude Code / Cursor / Copilot) as a BYOK Temporal activity. Slice 1 is READ-ONLY —
 * `claude -p` in plan mode with tools clamped to Read/Grep/Glob (no Bash/write/clone/PR;
 * those land in later slices behind the sandbox). `tool` selects the driver (default
 * "claude"); the credential is the tenant's key for that tool's provider.
 */
export interface CodeAgentNodeConfig {
  /** Which coding-CLI driver to run. Defaults to "claude". */
  tool?: "claude" | "cursor" | "copilot";
  /** The task prompt. `{{ nodeId.path }}` upstream templating is resolved before the activity. */
  prompt: string;
  /** Appended to the CLI's system prompt (e.g. house rules). */
  systemPrompt?: string;
  /** Model override; defaults to the tenant's provider default. */
  model?: string;
  /** Hard turn cap for the agentic loop. */
  maxTurns?: number;
  /** Hard cost stop (USD) passed to the CLI. */
  maxBudgetUsd?: number;
  /** Overall wall-clock budget for the run (ms). */
  timeoutMs?: number;
  /** "read" (default) = in-worker plan-mode run. "write" = clone `repo` + edit it in the sandbox,
   *  returning a diff (Slice 2c; gated by CODE_AGENT_WRITE_ENABLED on the worker). */
  mode?: "read" | "write";
  /** "owner/name" of the repo to clone (write mode). */
  repo?: string;
  /** Base branch to clone (write mode); defaults to the repo's default branch. */
  branch?: string;
  /** GitHub App connection authorizing the clone (write mode). Token used OUTSIDE the sandbox. */
  connectionId?: string;
  /** Write mode + PR (#444): after a successful run with a non-empty diff, commit the sandbox's
   *  edits to a node-owned branch, push it (with the same App token, OUTSIDE the sandbox), and open
   *  a pull request. Off by default — write mode alone just returns the diff. */
  openPr?: boolean;
  /** PR title (write+`openPr`). `{{…}}` templated before the activity. Defaults to a generic title. */
  prTitle?: string;
  /** PR body (write+`openPr`). `{{…}}` templated before the activity. */
  prBody?: string;
  /** Commit message for the pushed edits (write+`openPr`). Defaults to the PR title. */
  commitMessage?: string;
  /** Head branch to create/push (write+`openPr`). Node-owned + force-pushed, so a re-run updates it.
   *  Defaults to `naary/code-agent/<runId>` (deterministic per node+execution). */
  headBranch?: string;
  /** Flat fallback cost metered if the CLI reports no usage (fail-safe, never zero). */
  costUsd?: number;
}

/**
 * Native integration node (design docs/design/INTEGRATION-NODES.md). One node type
 * parameterized by { provider, action } that index into INTEGRATION_CATALOG; the
 * catalog defines the HTTP method/path/fields, so adding an integration is a catalog
 * entry, not a new node type.
 *
 * SECURITY (Tier-1 rule 4): like httpRequest, auth NEVER lives here — it comes via
 * `connectionId`, resolved + attached IN the activity. `fields` are non-secret values.
 */
export interface IntegrationNodeConfig {
  /** Catalog provider key, e.g. "github" | "jira". */
  provider: string;
  /** Catalog action key, e.g. "create_issue". */
  action: string;
  /** Connection supplying auth (+ the site base URL for connection-based providers). */
  connectionId: string;
  /** Static field values (catalog fields: path/query/body). */
  fields?: Record<string, unknown>;
  /** fieldKey → upstream output binding; overrides the static value of the same key. */
  fieldBindings?: Record<string, ArgBinding>;
}
