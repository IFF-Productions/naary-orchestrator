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
}

/** Normalized result the activity + workflow understand, regardless of which CLI ran. */
export interface CodeAgentEnvelope {
  /** The model's final text (a plan/summary in read-only mode). */
  result: string;
  /** Structured "needs input" questions (Q&A loop; unused until a later slice). */
  questions?: string[];
  /** CLI session id for `--resume` (Q&A loop; if the CLI supports it). */
  sessionId?: string;
  usage?: { costUsd?: number; inputTokens?: number; outputTokens?: number };
  /** True when the CLI reported a failure even on a 0 exit (Claude: `is_error`). */
  isError: boolean;
}

export interface CliAgentDriver {
  tool: CodeAgentTool;
  /** The CLI binary to exec (must be present in the run environment / image). */
  binary: string;
  /** Container image with the CLI installed — used once the sandbox lands (Slice 2). */
  image: string;
  /** Env var carrying the tenant credential; the git token NEVER goes here. */
  keyEnvVar: string;
  /** The BYOK credential provider to fetch for this tool (e.g. claude → "anthropic"). */
  credentialProvider: string;
  capabilities: {
    headless: boolean;
    resume: boolean;
    structuredQuestions: boolean;
  };
  /** Build the argv for a headless, read-only run (Slice 1). */
  buildArgs(opts: CodeAgentRunOpts): string[];
  /** Parse the CLI's stdout + exit code → the normalized envelope. */
  parse(stdout: string, exitCode: number): CodeAgentEnvelope;
}

/** Claude Code — the reference driver. `claude -p --output-format json`, plan mode. */
const claudeDriver: CliAgentDriver = {
  tool: "claude",
  binary: "claude",
  image: "naary-claude-sandbox",
  keyEnvVar: "ANTHROPIC_API_KEY",
  credentialProvider: "anthropic",
  capabilities: { headless: true, resume: true, structuredQuestions: true },
  buildArgs(opts) {
    const args = [
      "-p",
      opts.prompt,
      "--output-format",
      "json",
      // Slice 1: read-only. Plan mode + a clamped, read-only toolset — no Bash, no writes.
      "--permission-mode",
      "plan",
      "--allowedTools",
      "Read,Grep,Glob",
    ];
    if (opts.systemPrompt)
      args.push("--append-system-prompt", opts.systemPrompt);
    if (opts.model) args.push("--model", opts.model);
    if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
    if (opts.maxBudgetUsd)
      args.push("--max-budget-usd", String(opts.maxBudgetUsd));
    return args;
  },
  parse(stdout, exitCode) {
    // `claude -p --output-format json` emits a single JSON envelope. A non-zero exit with
    // no parseable envelope is a hard failure; check `is_error` even on exit 0.
    let env: {
      result?: string;
      is_error?: boolean;
      session_id?: string;
      total_cost_usd?: number;
      total_usage?: { input_tokens?: number; output_tokens?: number };
    } | null = null;
    try {
      env = JSON.parse(stdout.trim());
    } catch {
      env = null;
    }
    if (!env) {
      return { result: "", isError: true };
    }
    return {
      result: typeof env.result === "string" ? env.result : "",
      sessionId: env.session_id,
      isError: env.is_error === true || exitCode !== 0,
      usage: {
        costUsd: env.total_cost_usd,
        inputTokens: env.total_usage?.input_tokens,
        outputTokens: env.total_usage?.output_tokens,
      },
    };
  },
};

/** Registry of available drivers. Cursor/Copilot are additive adapters (later slices). */
const DRIVERS: Record<CodeAgentTool, CliAgentDriver | undefined> = {
  claude: claudeDriver,
  cursor: undefined,
  copilot: undefined,
};

/** Resolve the driver for a tool (default "claude"). Throws if the tool has no driver yet. */
export function resolveDriver(tool: CodeAgentTool | undefined): CliAgentDriver {
  const driver = DRIVERS[tool ?? "claude"];
  if (!driver) {
    throw new Error(
      `codeAgent: the "${tool}" driver isn't available yet (only "claude" today).`,
    );
  }
  return driver;
}
