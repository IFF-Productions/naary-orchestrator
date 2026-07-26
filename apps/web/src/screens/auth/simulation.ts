/**
 * Pure state logic for the auth screen's browser-only workflow simulation — a
 * recreation of the design comp's logic class (node-state sequencing, edge
 * coloring, status-bar copy). Zero I/O here: AuthScreen feeds it the REAL form
 * state plus the submit lifecycle stage (which tracks the REAL auth promise),
 * and this module only answers "what should the canvas draw".
 *
 * Palette note: the auth comp is hardcoded dark (no light variant), so these
 * are literal colors rather than theme tokens — the page intentionally renders
 * dark in both themes.
 */

export type AuthMode = "login" | "signup";
export type Provider = "google" | null;

/** Submit lifecycle. `verify → paused → provision` is the staged visual
 *  sequence started on submit; `done` only ever means the REAL auth promise
 *  resolved, and `failed` that it rejected — the simulation never fakes
 *  success. */
export type Stage =
  null | "verify" | "paused" | "provision" | "done" | "failed";

export type NodeStatus =
  "idle" | "active" | "running" | "paused" | "done" | "failed";

export type FocusField = "" | "name" | "email" | "pw";

/** Everything the canvas derives its drawing from — live form state + stage. */
export interface SimulationSignals {
  mode: AuthMode;
  provider: Provider;
  stage: Stage;
  focus: FocusField;
  name: string;
  email: string;
  password: string;
}

export const isEmailValid = (email: string): boolean => /.+@.+\..+/.test(email);
export const isPasswordOk = (password: string): boolean => password.length >= 6;
export const isNameOk = (name: string): boolean => name.trim().length >= 2;

/** Node 2 ("identify account") completeness — signup also needs a name. */
export function isIdentityDone(
  s: Pick<SimulationSignals, "mode" | "name" | "email">,
): boolean {
  return s.mode === "signup"
    ? isNameOk(s.name) && isEmailValid(s.email)
    : isEmailValid(s.email);
}

export function isFormReady(
  s: Pick<SimulationSignals, "mode" | "name" | "email" | "password">,
): boolean {
  return isIdentityDone(s) && isPasswordOk(s.password);
}

/** The five node states. Pre-submit they track the live fields (valid email ⇒
 *  node 2 done, password ≥6 ⇒ node 3 done, focus ⇒ active ember); once a stage
 *  is set the sequence takes over. */
export function nodeStatuses(
  s: SimulationSignals,
): [NodeStatus, NodeStatus, NodeStatus, NodeStatus, NodeStatus] {
  let n2: NodeStatus = isIdentityDone(s)
    ? "done"
    : s.focus === "email" || s.focus === "name" || s.email || s.name
      ? "active"
      : "idle";
  let n3: NodeStatus = isPasswordOk(s.password)
    ? "done"
    : s.focus === "pw" || s.password
      ? "active"
      : "idle";
  let n4: NodeStatus = "idle";
  let n5: NodeStatus = "idle";
  if (s.stage) {
    n2 = "done";
    n3 = "done";
  }
  if (s.stage === "verify") n4 = "running";
  else if (s.stage === "paused") n4 = "paused";
  else if (s.stage === "provision") {
    n4 = "done";
    n5 = "running";
  } else if (s.stage === "done") {
    n4 = "done";
    n5 = "done";
  } else if (s.stage === "failed") n4 = "failed";
  return ["done", n2, n3, n4, n5];
}

/**
 * The bot-protection gate, drawn as a SIDE process hanging off the trigger rather than a sixth node
 * in the chain — which is what it actually is. Turnstile gates *ingress*: it runs alongside the flow
 * and decides whether the request is admitted, it isn't a step the request passes through.
 *
 * Status follows the same real stage machine as the main nodes, so it can't claim more than the page
 * knows:
 *   - no stage yet ⇒ `idle` (nothing submitted, nothing checked)
 *   - `verify` ⇒ `running` (the gate is what runs first on submit)
 *   - anything after ⇒ `done` — including `failed`. A rejected credential does NOT mean the bot gate
 *     rejected you, and drawing it as failed would blame the wrong node for the outcome.
 */
export function botGateStatus(s: Pick<SimulationSignals, "stage">): NodeStatus {
  if (!s.stage) return "idle";
  return s.stage === "verify" ? "running" : "done";
}

/** Label for the side gate. Sublabel names the mechanism, matching the other cards' `x · y` shape. */
export const BOT_GATE_LABEL: readonly [string, string] = [
  "Bot protection",
  "turnstile · side gate",
];

/** Uppercase mono status word shown on each node card. */
export const STATE_WORD: Record<NodeStatus, string> = {
  idle: "idle",
  active: "active",
  running: "run",
  paused: "wait",
  done: "done",
  failed: "fail",
};

/** Node label + sublabel variants (the design's L table): OAuth beats mode. */
export function nodeLabels(
  mode: AuthMode,
  provider: Provider,
): ReadonlyArray<readonly [string, string]> {
  if (provider === "google")
    return [
      ["Sign-in request", "oauth · trigger"],
      ["Redirect to Google", "external identity"],
      ["OAuth consent", "scopes granted"],
      ["Exchange token", "verify with Google"],
      ["Resume session", "restore workspace"],
    ];
  if (mode === "login")
    return [
      ["Sign-in request", "event · trigger"],
      ["Identify account", "match work email"],
      ["Verify password", "credential check"],
      ["Approval gate", "human-in-the-loop"],
      ["Resume session", "restore workspace"],
    ];
  return [
    ["Create account", "event · trigger"],
    ["Register identity", "name + work email"],
    ["Set password", "credential check"],
    ["Verify email", "human-in-the-loop"],
    ["Provision workspace", "seed + finish"],
  ];
}

export interface CardVisual {
  borderColor: string;
  background: string;
  color: string;
  boxShadow: string;
  animation: string;
}

/** Node-card look per status (border / tinted bg / accent + glow + pulse). */
export function cardVisual(status: NodeStatus): CardVisual {
  const M: Record<NodeStatus, [string, string, string]> = {
    idle: ["#2c3542", "#141821", "#9aa4b2"],
    active: ["#f2622e", "#1a1310", "#ff8a4c"],
    running: ["#f2622e", "#1a1310", "#ff8a4c"],
    paused: ["#f5b544", "#1b1610", "#f5c869"],
    done: ["#35c47a", "#0f1a14", "#5fd598"],
    failed: ["#e07a6a", "#1a1010", "#e89286"],
  };
  const [borderColor, background, color] = M[status];
  let boxShadow = "none";
  if (status === "active" || status === "running")
    boxShadow =
      "0 0 0 1px rgba(242,98,46,.22), 0 10px 34px -12px rgba(242,98,46,.5)";
  else if (status === "paused")
    boxShadow =
      "0 0 0 1px rgba(245,181,68,.22), 0 10px 34px -12px rgba(245,181,68,.45)";
  else if (status === "done")
    boxShadow = "0 8px 26px -16px rgba(53,196,122,.6)";
  else if (status === "failed")
    boxShadow =
      "0 0 0 1px rgba(224,122,106,.22), 0 10px 34px -12px rgba(224,122,106,.45)";
  let animation = "none";
  if (status === "running")
    animation = "authCardPulse 1.4s ease-in-out infinite";
  else if (status === "paused")
    animation = "authCardPulse 1.05s ease-in-out infinite";
  return { borderColor, background, color, boxShadow, animation };
}

export interface EdgeVisual {
  stroke: string;
  dash: string;
  flowing: boolean;
}

/** Edges color by their TARGET node's status; active/running/paused targets
 *  get the dashed flowing march. */
export function edgeVisual(target: NodeStatus): EdgeVisual {
  const C: Record<NodeStatus, string> = {
    idle: "#242c38",
    active: "#f2622e",
    running: "#f2622e",
    paused: "#f5b544",
    done: "#35c47a",
    failed: "#e07a6a",
  };
  const flowing =
    target === "active" || target === "running" || target === "paused";
  return { stroke: C[target], dash: flowing ? "6 8" : "0", flowing };
}

export interface StatusBarState {
  text: string;
  dot: string;
  failed: boolean;
}

/** Status-bar copy + dot color for the current signals. */
export function statusBar(s: SimulationSignals): StatusBarState {
  const oauth = s.provider === "google";
  const login = s.mode === "login";
  switch (s.stage) {
    case "verify":
      return {
        text: oauth ? "Redirecting to Google…" : "Verifying credentials…",
        dot: "#f2622e",
        failed: false,
      };
    case "paused":
      return {
        text: oauth
          ? "Waiting for Google consent…"
          : "Paused — auto-approving human gate…",
        dot: "#f5b544",
        failed: false,
      };
    case "provision":
      return {
        text: oauth
          ? "Exchanging token & resuming…"
          : login
            ? "Resuming your session…"
            : "Provisioning your workspace…",
        dot: "#f2622e",
        failed: false,
      };
    case "done":
      return {
        text: oauth
          ? "Signed in with Google."
          : login
            ? "Authenticated — welcome back."
            : "Workspace ready — welcome aboard.",
        dot: "#35c47a",
        failed: false,
      };
    case "failed":
      // Honest failure: the real auth promise rejected — the run stops here
      // (the form shows the actual error message).
      return {
        text: "Run failed — fix the error in the form and retry.",
        dot: "#e07a6a",
        failed: true,
      };
    default:
      break;
  }
  if (!isIdentityDone(s))
    return {
      text: "Awaiting account identity…",
      dot: "#5c6573",
      failed: false,
    };
  if (!isPasswordOk(s.password))
    return {
      text: "Account identified · enter password",
      dot: "#f2622e",
      failed: false,
    };
  return {
    text: `Ready to run · press ${login ? "Sign in" : "Create account"}`,
    dot: "#f2622e",
    failed: false,
  };
}

/** Mono run-id chip on the status bar. */
export function runIdChip(s: SimulationSignals): string {
  if (!s.stage) return "run_a1f · idle";
  return `run_a1f · #${s.provider ? "oauth" : s.mode}`;
}
