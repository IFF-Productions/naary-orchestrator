/**
 * CLI-agent drivers (design docs/design/CLAUDE-CODE-NODE.md §8c). The `codeAgent` node is
 * tool-agnostic: a driver adapts one agentic coding CLI (Claude Code / Cursor / Copilot)
 * behind a common contract. Everything CLI-specific — the argv, the auth env var, and how
 * to parse the CLI's output — lives here; the activity + workflow stay driver-independent.
 *
 * These functions are PURE (build argv / parse text). The subprocess execution + credential
 * fetch live in the activity (`callCodeAgent`), so drivers are trivially unit-tested.
 *
 * Slice 1 is READ-ONLY: the claude driver runs `claude -p` in plan mode with tools clamped
 * to Read/Grep/Glob (no Bash/write/clone). Resume/questions (the Q&A loop) and Cursor/Copilot
 * drivers land in later slices.
 */

export type CodeAgentTool = "claude" | "cursor" | "copilot";

export interface CodeAgentRunOpts {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Write mode (Slice 2c): the CLI may EDIT files in the sandbox (acceptEdits + Edit/Write),
   *  vs the read-only default (plan mode, Read/Grep/Glob). Still no Bash in either mode. */
  write?: boolean;
  /** JSON Schema constraining the final answer. Only meaningful for a driver whose
   *  `capabilities.structuredOutput` is true — the caller checks before passing it. */
  outputSchema?: Record<string, unknown>;
}

/**
 * One COMPACT, SECRET-FREE step of the agent's execution trace — distilled from the CLI's
 * streaming (`stream-json`) NDJSON so a run is debuggable without shipping the raw stream.
 * Bounded by design: every string field is truncated (see `MAX_TRACE_FIELD_CHARS`) and the
 * whole trace is capped (`MAX_TRACE_STEPS`), so a huge run can't blow the Temporal payload.
 * The CLI never emits the auth token; we also never echo env into a step.
 */
export interface TraceStep {
  /** `assistant` = the model's text/reasoning; `tool` = a tool call (Read/Grep/Glob/…);
   *  `result` = the final summary; `truncated` = a synthetic marker when the cap was hit. */
  kind: "assistant" | "tool" | "result" | "truncated";
  /** Assistant reasoning text, the final result text, or the truncation note (truncated). */
  text?: string;
  /** Tool NAME for `kind:"tool"` — e.g. Read/Grep/Glob/Edit/Write. */
  tool?: string;
  /** SHORT summary of the tool input (e.g. the file path / grep pattern), truncated. */
  toolInput?: string;
  /** True on the final `result` step when the CLI reported a failure (mirrors `isError`). */
  isError?: boolean;
}

/** Trace bounds — keep the offloaded/inline trace comfortably small. */
export const MAX_TRACE_STEPS = 500;
export const MAX_TRACE_FIELD_CHARS = 2000;

/** Truncate a string field to the per-field cap (a secret-free bound on a single step). */
function truncateField(s: string): string {
  return s.length > MAX_TRACE_FIELD_CHARS
    ? `${s.slice(0, MAX_TRACE_FIELD_CHARS)}… [truncated]`
    : s;
}

/** Normalized result the activity + workflow understand, regardless of which CLI ran. */
export interface CodeAgentEnvelope {
  /** The model's final text (a plan/summary in read-only mode). */
  result: string;
  /** The schema-constrained answer, PARSED, when the run supplied an outputSchema and the driver
   *  supports it. `result` still carries the same value as text. */
  structured?: Record<string, unknown>;
  /** Structured "needs input" questions (Q&A loop; unused until a later slice). */
  questions?: string[];
  /** CLI session id for `--resume` (Q&A loop; if the CLI supports it). */
  sessionId?: string;
  usage?: { costUsd?: number; inputTokens?: number; outputTokens?: number };
  /** True when the CLI reported a failure even on a 0 exit (Claude: `is_error`). */
  isError: boolean;
  /** Compact, secret-free step-by-step execution trace (from `stream-json`). Absent when
   *  the CLI wasn't run in streaming mode or emitted nothing parseable. */
  trace?: TraceStep[];
  /** On a failure, the CLI's own reason code so the run + its Sentry issue are diagnosable
   *  (#551) — e.g. Claude's `error_max_turns` / `error_during_execution`, or `no_envelope`
   *  when the process died before emitting JSON. Undefined on success / when the CLI gave none. */
  failureSubtype?: string;
}

export interface CliAgentDriver {
  tool: CodeAgentTool;
  /** The CLI binary to exec (must be present in the run environment / image). */
  binary: string;
  /** Container image with the CLI installed — used once the sandbox lands (Slice 2). */
  image: string;
  /** The BYOK credential provider to fetch for this tool (e.g. claude → "claude-code"). This is a
   *  DEDICATED slot, separate from the `anthropic` model-provider API key. */
  credentialProvider: string;
  /** The auth env var(s) to inject into the CLI subprocess for a given credential value. Returns a
   *  map (not a fixed name) because the same credential slot may hold different token kinds that the
   *  CLI reads from different vars. The git token NEVER goes here. */
  authEnv(key: string): Record<string, string>;
  capabilities: {
    headless: boolean;
    resume: boolean;
    structuredQuestions: boolean;
    /** The CLI can CONSTRAIN its final answer to a caller-supplied JSON Schema (Claude Code's
     *  `--json-schema`), returning the parsed object. Not the same as `structuredQuestions`, which
     *  is the Q&A pause. False ⇒ the activity refuses an outputSchema rather than approximating. */
    structuredOutput: boolean;
  };
  /** Build the argv for a headless, read-only run (Slice 1). */
  buildArgs(opts: CodeAgentRunOpts): string[];
  /** Parse the CLI's stdout + exit code → the normalized envelope. */
  parse(stdout: string, exitCode: number): CodeAgentEnvelope;
}

/** Claude Code — the reference driver. `claude -p --output-format stream-json --verbose`, plan mode. */
const claudeDriver: CliAgentDriver = {
  tool: "claude",
  binary: "claude",
  image: "naary-claude-sandbox",
  credentialProvider: "claude-code",
  // A `claude setup-token` OAuth token (sk-ant-oat…) authenticates the CLI via
  // CLAUDE_CODE_OAUTH_TOKEN (subscription billing); a plain API key (sk-ant-api…) via
  // ANTHROPIC_API_KEY. Return exactly ONE var so the CLI's precedence isn't ambiguous.
  authEnv(key) {
    const k = key.trim();
    const varName = k.startsWith("sk-ant-oat")
      ? "CLAUDE_CODE_OAUTH_TOKEN"
      : "ANTHROPIC_API_KEY";
    return { [varName]: k };
  },
  capabilities: {
    headless: true,
    resume: true,
    structuredQuestions: true,
    structuredOutput: true,
  },
  buildArgs(opts) {
    const args = [
      "-p",
      opts.prompt,
      // stream-json emits the FULL agentic trace as NDJSON (one message per line) so we can
      // capture what the agent read/grepped + its reasoning. `--verbose` is REQUIRED by Claude
      // Code alongside stream-json in `-p` mode (it refuses the combination otherwise).
      "--output-format",
      "stream-json",
      "--verbose",
      // Read (default): plan mode + a clamped read-only toolset. Write (Slice 2c, sandbox only):
      // acceptEdits + Edit/Write so the model can change files; still NO Bash in either mode.
      "--permission-mode",
      opts.write ? "acceptEdits" : "plan",
      "--allowedTools",
      opts.write ? "Read,Grep,Glob,Edit,Write" : "Read,Grep,Glob",
    ];
    if (opts.systemPrompt)
      args.push("--append-system-prompt", opts.systemPrompt);
    if (opts.model) args.push("--model", opts.model);
    if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
    if (opts.maxBudgetUsd)
      args.push("--max-budget-usd", String(opts.maxBudgetUsd));
    // Structured output: the CLI constrains the model to this schema and puts the PARSED object on
    // the final result message as `structured_output` (verified live against the pinned CLI, in
    // this exact stream-json mode — `--output-format json` behaves the same but is not what we run).
    if (opts.outputSchema)
      args.push("--json-schema", JSON.stringify(opts.outputSchema));
    return args;
  },
  parse(stdout, exitCode) {
    // `claude -p --output-format stream-json --verbose` emits NDJSON: one JSON message per line —
    // `system` (init), `assistant` (text + tool_use blocks), `user` (tool_result blocks), and a
    // final `type:"result"` message (the same envelope the old `--output-format json` mode emitted:
    // result/is_error/session_id/total_cost_usd/usage). We walk the lines to collect a COMPACT,
    // bounded, secret-free `trace` and read the final result message for the normalized fields.
    const trace: TraceStep[] = [];
    let truncated = false;
    /** The final `type:"result"` message — the run's outcome envelope. */
    interface ResultMsg {
      result?: string;
      is_error?: boolean;
      subtype?: string;
      session_id?: string;
      total_cost_usd?: number;
      // stream-json names this `usage`; the older `json` mode used `total_usage` — accept either.
      usage?: { input_tokens?: number; output_tokens?: number };
      total_usage?: { input_tokens?: number; output_tokens?: number };
      /** Present only when the run passed `--json-schema`: the schema-constrained answer, already
       *  parsed by the CLI (`result` carries the same value as a JSON string). */
      structured_output?: unknown;
    }
    /** Set once the `type:"result"` line is seen; null if the process died first. */
    let final: ResultMsg | null = null;

    const pushStep = (step: TraceStep): void => {
      if (truncated) return;
      if (trace.length >= MAX_TRACE_STEPS) {
        truncated = true;
        trace.push({
          kind: "truncated",
          text: `Trace truncated at ${MAX_TRACE_STEPS} steps — more steps ran but were dropped to bound the payload.`,
        });
        return;
      }
      trace.push(step);
    };

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue; // tolerate blank lines
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // tolerate a garbage/partial line
      }
      if (!msg || typeof msg !== "object") continue;
      const m = msg as {
        type?: string;
        message?: { content?: unknown };
        [k: string]: unknown;
      };
      if (m.type === "assistant") {
        // The model's turn: text (reasoning/plan) + tool_use (a Read/Grep/Glob/… call).
        const content = Array.isArray(m.message?.content)
          ? m.message.content
          : [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block?.type === "text" && typeof block.text === "string") {
            const text = block.text.trim();
            if (text)
              pushStep({ kind: "assistant", text: truncateField(text) });
          } else if (
            block?.type === "tool_use" &&
            typeof block.name === "string"
          ) {
            // Capture the tool NAME + a short input summary (file path / pattern). Never the
            // tool_result body (file contents) — keep the trace compact and free of large blobs.
            const input =
              block.input === undefined ? "" : safeStringify(block.input);
            pushStep({
              kind: "tool",
              tool: truncateField(block.name),
              ...(input ? { toolInput: truncateField(input) } : {}),
            });
          }
        }
      } else if (m.type === "result") {
        // The final outcome envelope (same fields as the old single-JSON mode).
        final = m as ResultMsg;
      }
      // `system` init and `user` tool_result lines carry no compact-trace value — skipped.
    }

    if (!final) {
      // No `result` line ⇒ the process died before finishing. Preserve today's `no_envelope`
      // failure behavior (#551 diagnosability); still surface whatever partial trace we captured.
      return {
        result: "",
        isError: true,
        failureSubtype: "no_envelope",
        ...(trace.length ? { trace } : {}),
      };
    }

    const isError = final.is_error === true || exitCode !== 0;
    const resultText = typeof final.result === "string" ? final.result : "";
    // Append the final result as a trace step so the log reads end-to-end.
    if (resultText || isError) {
      pushStep({
        kind: "result",
        ...(resultText ? { text: truncateField(resultText) } : {}),
        ...(isError ? { isError: true } : {}),
      });
    }
    const usage = final.usage ?? final.total_usage;
    // `--json-schema` puts the PARSED answer here (verified live against the pinned CLI in this
    // stream-json mode). Guarded: only a plain object is passed through, so a CLI change that made
    // it a string or an array can't silently reach ctx as the wrong shape.
    const structured =
      final.structured_output !== null &&
      typeof final.structured_output === "object" &&
      !Array.isArray(final.structured_output)
        ? (final.structured_output as Record<string, unknown>)
        : undefined;
    return {
      result: resultText,
      sessionId: final.session_id,
      isError,
      ...(structured ? { structured } : {}),
      // The CLI's own reason on failure (Claude sets `subtype`); fall back to a nonzero-exit
      // marker so a failure is never reasonless (#551 — feeds the Sentry fingerprint).
      failureSubtype: isError
        ? typeof final.subtype === "string" && final.subtype
          ? final.subtype
          : exitCode !== 0
            ? `exit_${exitCode}`
            : "unknown"
        : undefined,
      usage: {
        costUsd: final.total_cost_usd,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      },
      ...(trace.length ? { trace } : {}),
    };
  },
};

/** JSON.stringify that never throws (circular refs) — for a tool-input summary only. */
function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return "";
  }
}

/* -------------------------- shared JSON-envelope parsing -------------------------- */

/** Every parseable JSON OBJECT (not array) in the stdout, in order. Handles all three shapes a CLI
 *  might emit: a single object (`--output-format json`), a PRETTY-PRINTED single object spanning
 *  multiple lines, and line-delimited JSONL / stream-json. */
function jsonObjects(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  // Fast path: the WHOLE stdout is one JSON object — covers a pretty-printed (multi-line) result,
  // which a per-line parse would miss entirely (→ a spurious "no_envelope" on a successful run).
  try {
    const o = JSON.parse(trimmed);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      return [o as Record<string, unknown>];
    }
  } catch {
    /* not a single whole-object → fall back to line-by-line (JSONL / stream-json) */
  }
  const out: Record<string, unknown>[] = [];
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        out.push(o as Record<string, unknown>);
      }
    } catch {
      /* tolerate a non-JSON / partial line */
    }
  }
  return out;
}

/** First present, non-empty STRING among `keys` (defensive read across CLI schema variants). */
function firstString(
  o: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * Cursor Agent CLI (`cursor-agent`). Docs: cursor.com/docs/cli. Headless `-p`, `--output-format json`
 * emits ONE object `{ type:"result", subtype, is_error, result, session_id, duration_ms }`. Auth via
 * CURSOR_API_KEY. WRITE mode passes `--force` (apply edits); READ mode omits it — cursor then only
 * PROPOSES changes (nothing is applied), the plan-mode equivalent. Cursor's json result carries no
 * token/cost, so `usage` is left undefined and the activity's char/4 billing fallback covers it.
 */
const cursorDriver: CliAgentDriver = {
  tool: "cursor",
  binary: "cursor-agent",
  image: "naary-cursor-sandbox",
  credentialProvider: "cursor",
  authEnv(key) {
    return { CURSOR_API_KEY: key.trim() };
  },
  capabilities: {
    headless: true,
    resume: false,
    structuredQuestions: false,
    structuredOutput: false,
  },
  buildArgs(opts) {
    // Cursor has no system-prompt flag — fold it into the prompt.
    const prompt = opts.systemPrompt
      ? `${opts.systemPrompt}\n\n${opts.prompt}`
      : opts.prompt;
    const args = ["-p", prompt, "--output-format", "json"];
    if (opts.write) args.push("--force"); // apply edits (sandbox); read = propose-only (default)
    if (opts.model) args.push("--model", opts.model);
    return args;
  },
  parse(stdout, exitCode) {
    const objs = jsonObjects(stdout);
    const obj = objs[objs.length - 1]; // cursor `json` = a single result object (last, to tolerate noise)
    if (!obj) {
      return { result: "", isError: true, failureSubtype: "no_envelope" };
    }
    const isError = obj.is_error === true || exitCode !== 0;
    const resultText = firstString(obj, ["result"]) ?? "";
    return {
      result: resultText,
      sessionId: firstString(obj, ["session_id"]),
      isError,
      failureSubtype: isError
        ? (firstString(obj, ["subtype"]) ??
          (exitCode !== 0 ? `exit_${exitCode}` : "unknown"))
        : undefined,
    };
  },
};

/**
 * GitHub Copilot CLI (`copilot`). Docs: docs.github.com/copilot/reference/copilot-cli-reference.
 * Headless `-p`, `--output-format json` (JSONL). Auth env precedence COPILOT_GITHUB_TOKEN > GH_TOKEN
 * > GITHUB_TOKEN — we inject the dedicated highest-precedence var. Tool clamp (parity with the claude
 * driver's no-Bash invariant): `read` always; `write` only in write mode; `shell` NEVER. NB the exact
 * terminal-object schema isn't fully documented, so the result/error read is DEFENSIVE across field
 * names — verify against the installed CLI version before relying on this in production.
 */
const copilotDriver: CliAgentDriver = {
  tool: "copilot",
  binary: "copilot",
  image: "naary-copilot-sandbox",
  credentialProvider: "copilot",
  authEnv(key) {
    return { COPILOT_GITHUB_TOKEN: key.trim() };
  },
  capabilities: {
    headless: true,
    resume: false,
    structuredQuestions: false,
    structuredOutput: false,
  },
  buildArgs(opts) {
    const prompt = opts.systemPrompt
      ? `${opts.systemPrompt}\n\n${opts.prompt}`
      : opts.prompt;
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--allow-tool",
      "read",
    ];
    if (opts.write) args.push("--allow-tool", "write");
    else args.push("--deny-tool", "write");
    args.push("--deny-tool", "shell"); // no shell in either mode (claude-parity)
    if (opts.model) args.push("--model", opts.model);
    return args;
  },
  parse(stdout, exitCode) {
    const objs = jsonObjects(stdout);
    // The final object carrying a result-ish field is the outcome; else the last object (for a
    // reasoned failure). Field names vary by version, so read defensively.
    const RESULT_KEYS = ["result", "response", "content", "text", "message"];
    const obj =
      [...objs].reverse().find((o) => firstString(o, RESULT_KEYS)) ??
      objs[objs.length - 1];
    if (!obj) {
      return { result: "", isError: true, failureSubtype: "no_envelope" };
    }
    const isError =
      obj.is_error === true ||
      obj.isError === true ||
      (obj.error != null && obj.error !== false) ||
      exitCode !== 0;
    return {
      result: firstString(obj, RESULT_KEYS) ?? "",
      isError,
      failureSubtype: isError
        ? exitCode !== 0
          ? `exit_${exitCode}`
          : "unknown"
        : undefined,
    };
  },
};

/** Registry of available drivers. Add an entry + the driver above when a new CLI is adapted. */
const DRIVERS: Record<CodeAgentTool, CliAgentDriver> = {
  claude: claudeDriver,
  cursor: cursorDriver,
  copilot: copilotDriver,
};

/** Resolve the driver for a tool (default "claude"). Tolerant of any runtime string so a stale
 *  saved graph naming a removed tool fails cleanly instead of crashing. */
export function resolveDriver(tool: string | undefined): CliAgentDriver {
  const driver = DRIVERS[(tool ?? "claude") as CodeAgentTool];
  if (!driver) {
    throw new Error(
      `codeAgent: unknown coding-CLI tool "${tool}" (expected claude/cursor/copilot).`,
    );
  }
  return driver;
}
