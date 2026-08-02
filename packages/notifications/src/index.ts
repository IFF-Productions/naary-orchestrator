/**
 * Pure notification formatters shared by the worker (which SENDS them) and the web app (which
 * PREVIEWS them in Storybook). No `process.env`, no crypto, no I/O — the caller resolves the
 * links and passes them in as data. That boundary is load-bearing: token/URL minting reads
 * `ENCRYPTION_KEY` and must stay worker-side (CLAUDE.md §4), so it never enters this module and
 * therefore never enters the browser bundle.
 */

export type NotificationKind =
  | "approval_pending"
  | "run_failed"
  /** Monthly spend crossed the budget's alert threshold (redesign Slice 3). Tenant-scoped
   *  (not a run outcome) — fired at most once per calendar month, from the reservation
   *  path. Channels opt in via `onBudgetThreshold`. */
  | "budget_threshold"
  /** A workflow definition was promoted into an environment (redesign Slice 4). Not a run
   *  event — `workflowId` carries the WORKFLOW KEY (there is no run). Sent API-side from
   *  the promote path to the TARGET env's channels; channels opt in via `onPromotion`. */
  | "promotion"
  /**
   * A self-healing FIX PROPOSAL is waiting for a decision (Phase 2). Not a run outcome — the run
   * has already failed and reported that separately; this says a CHANGE to the workflow has been
   * drafted and needs a human.
   *
   * It reuses the `onApprovalPending` channel toggle rather than introducing one, for the same
   * reason the approval FLAVORS do: it is the same conversation — "someone has to decide
   * something" — retold about a workflow instead of a run. Self-healing is already opt-in per
   * workflow and off by default, so a tenant only ever receives these for a workflow they
   * deliberately switched on.
   */
  | "fix_proposal";

/** Sub-flavor of an `approval_pending` notification (REDESIGN-FUNCTIONALITY-GAPS.md Slice 1):
 *  undefined = the initial pause; "reminder" = a scheduled (or manual "Remind now") nudge;
 *  "escalation" = the gate's escalation deadline elapsed. Flavors reuse the approval channel
 *  toggle (`onApprovalPending`) — they are the same conversation, retold. */
export type ApprovalFlavor = "reminder" | "escalation";

/** The run facts a notification describes (worker adds `tenantId` upstream; formatting never needs it). */
export interface NotificationInput {
  kind: NotificationKind;
  workflowId: string;
  workflowKey?: string;
  /** For approval_pending: the approval node's title (from the graph). */
  title?: string;
  /** For run_failed: WHY it failed in the reader's words — the thrown error's message, or the
   *  terminal status for a run that returned one (rejected / budget_exceeded / …). It used to be
   *  the literal "failed", which only restated the header (#987); a detail that restates the
   *  status the header already announces is dropped by `notificationDetail`. */
  detail?: string;
  /** run_failed only: the failure's machine type — an `ApplicationFailure.type` such as
   *  `AGENT_TIMEOUT`. Shown next to the workflow name; it is the part an operator recognizes. */
  errorType?: string;
  /** run_failed only: the graph node the run failed AT. The single most useful fact in a failure
   *  alert ("which step?") and the one the old message threw away. */
  failedNodeId?: string;
  /** approval_pending only: reminder/escalation flavor (absent = the initial pause). */
  flavor?: ApprovalFlavor;
  /** For flavor "reminder": the 1-based reminder number ("Reminder #2"). */
  reminderIndex?: number;
  /** For flavor "escalation": who the escalation mentions (free-form, e.g. "@ops-oncall"). */
  escalateTo?: string;
  /** budget_threshold only: the configured threshold (% of the monthly cap). */
  thresholdPct?: number;
  /** budget_threshold only: the monthly cap in USD. */
  capUsd?: number;
  /** budget_threshold only: month spend at the crossing (committed + reserved), USD. */
  spendUsd?: number;
  /** promotion only: SOURCE environment name (e.g. "sandbox"). */
  fromEnv?: string;
  /** promotion only: TARGET environment name (e.g. "prod"). */
  toEnv?: string;
  /** promotion only: the new version number in the target environment. */
  version?: number;
}

/** Compact USD for notification copy: cents for small figures, 2dp otherwise. */
function usd(n: number): string {
  return `$${n.toFixed(n > 0 && n < 1 ? 4 : 2)}`;
}

/**
 * Resolved, absolute links computed by the CALLER. The worker builds these from `APP_BASE_URL`
 * plus a signed HMAC token; Storybook passes fakes. Both are optional — when absent (no
 * `APP_BASE_URL`, or a relative link that's useless as a button) the formatter omits the action.
 */
export interface NotificationLinks {
  /** Signed approve/reject base URL (`…/approve/:id?token=…`); buttons append `&decision=`. */
  approvalUrl?: string;
  /** Deep link to the run detail page. */
  runUrl?: string;
  /** Deep link to the Usage & budgets page (budget_threshold). */
  usageUrl?: string;
  /** Deep link to the workflow's detail page (promotion). */
  workflowUrl?: string;
}

export type NotificationAction = {
  label: string;
  url: string;
  /** Slack button colour: primary (green) for approve, danger (red) for reject. */
  style?: "primary" | "danger";
};

/** Escape the three characters Slack treats as mrkdwn control chars (& < >) so an id/label
 *  containing them can't break a `<url|label>` link or inject markup. `&` first, always. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Safe to embed inside a Slack inline-code span (`` `…` ``): slackEscape does NOT neutralize
 *  backticks, so a value containing one would close the code span and mangle the message. Replace
 *  backticks with a modifier-letter apostrophe (renders near-identically) after escaping. */
export function codeText(s: string): string {
  return slackEscape(s).replace(/`/g, "ʼ");
}

/** Longest failure/reason text any surface renders. A thrown error's message is unbounded
 *  (a provider can return a page of JSON); a chat alert that scrolls for a screen is worse
 *  than one that stops at the useful part. */
const DETAIL_MAX = 240;

/** Collapse whitespace (a multi-line stack-ish message becomes one line) and cut to `max`
 *  on a whole character with an ellipsis, so nothing renders as a wall of text. */
function oneLine(s: string, max = DETAIL_MAX): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Execution ids are 48 machine-shaped characters. As a link LABEL one wraps onto two lines and
 * is most of what made the old message look broken (#987) — nobody reads a UUID. Show a
 * recognizable PREFIX in small context text instead; the full id still rides the generic
 * payload (`workflowId`), the Teams/email facts, and the deep link itself.
 */
export function shortId(id: string, max = 24): string {
  return id.length <= max ? id : `${id.slice(0, max - 4)}…`;
}

/**
 * The failure reason to SHOW, or undefined when it adds nothing. ONE rule, consumed by the Slack
 * blocks, the Teams/email facts and the fallback text — two copies of this rule is exactly the
 * drift bug #982/#984 fixed.
 *
 * Dropped when: the kind carries no reason at all (approvals say what they're awaiting instead);
 * the detail is blank; or — the `Reason: failed` defect — the detail is only the status the
 * header already announced. "❌ Run failed" + "Reason: failed" told the reader nothing twice.
 * Every OTHER terminal status a run can return (rejected / budget_exceeded / circuit_open /
 * invalid_graph) genuinely adds information, so this is a redundancy test, not a blocklist.
 */
export function notificationDetail(
  input: NotificationInput,
): string | undefined {
  if (input.kind === "approval_pending") return undefined;
  const raw = input.detail?.trim();
  if (!raw) return undefined;
  if (input.kind === "run_failed" && raw.toLowerCase() === "failed")
    return undefined;
  return oneLine(raw);
}

/** Short headline for the notification, shared by the Slack header + the Teams card. */
export function notificationHeader(input: NotificationInput): string {
  if (input.kind === "budget_threshold") {
    return input.thresholdPct !== undefined
      ? `📊 Budget alert — ${input.thresholdPct}% of the monthly cap`
      : "📊 Budget alert";
  }
  if (input.kind === "promotion") {
    return input.toEnv
      ? `🚀 Workflow promoted to ${input.toEnv}`
      : "🚀 Workflow promoted";
  }
  if (input.kind === "fix_proposal") {
    // Says what it IS, not that an AI made it: the reader's decision is about the change.
    return "🛠 A fix is proposed for a failing workflow";
  }
  if (input.kind !== "approval_pending") return "❌ Run failed";
  if (input.flavor === "reminder") {
    return input.reminderIndex
      ? `⏰ Approval reminder #${input.reminderIndex}`
      : "⏰ Approval reminder";
  }
  if (input.flavor === "escalation") return "🚨 Approval escalated";
  return "⏳ Approval needed";
}

/** The action links a recipient can act on — Approve/Reject for a pause (each with the
 *  choice pre-selected on the signed page) plus View run. Shared by the Slack blocks and
 *  the Teams card so both stay in step. */
export function notificationActions(
  input: NotificationInput,
  links: NotificationLinks,
): NotificationAction[] {
  const actions: NotificationAction[] = [];
  if (input.kind === "approval_pending" && links.approvalUrl) {
    // Two one-click buttons instead of one "Approve / Reject": each deep-links to the
    // signed decision page with the choice pre-selected (?…&decision=approve|reject).
    // The page still requires an explicit confirm click, so a link-prefetch can't decide.
    actions.push({
      label: "✅ Approve",
      url: `${links.approvalUrl}&decision=approve`,
      style: "primary",
    });
    actions.push({
      label: "❌ Reject",
      url: `${links.approvalUrl}&decision=reject`,
      style: "danger",
    });
  }
  if (input.kind === "budget_threshold") {
    // Budget alerts act on the BUDGET, not a run — the one action is the usage page.
    if (links.usageUrl)
      actions.push({ label: "View usage & budgets", url: links.usageUrl });
    return actions;
  }
  if (input.kind === "promotion") {
    // Promotions act on the WORKFLOW, not a run — the one action is its detail page.
    if (links.workflowUrl)
      actions.push({ label: "View workflow", url: links.workflowUrl });
    return actions;
  }
  if (input.kind === "fix_proposal") {
    // NO approve/reject buttons, deliberately — unlike a run approval. Approving writes a new
    // version of a production workflow, and that decision is made against the DIFF, which a chat
    // message cannot show. The one action is to go and look at it.
    if (links.approvalUrl)
      actions.push({
        label: "Review the proposed fix",
        url: links.approvalUrl,
      });
    else if (links.workflowUrl)
      actions.push({ label: "View workflow", url: links.workflowUrl });
    return actions;
  }
  if (links.runUrl) actions.push({ label: "View run", url: links.runUrl });
  return actions;
}

/** Human-readable line for the notification (what a Slack/Teams webhook shows). Includes a
 *  deep link to the resource to act on: the signed approve/reject link for a pause, otherwise
 *  the run detail page. */
export function notificationText(
  input: NotificationInput,
  links: NotificationLinks,
): string {
  if (input.kind === "budget_threshold") {
    const pct =
      input.thresholdPct !== undefined
        ? `${input.thresholdPct}%`
        : "the alert threshold";
    const cap =
      input.capUsd !== undefined
        ? ` of the ${usd(input.capUsd)} monthly cap`
        : "";
    const spend =
      input.spendUsd !== undefined
        ? ` (${usd(input.spendUsd)} committed + reserved)`
        : "";
    const view = links.usageUrl ? ` View usage: ${links.usageUrl}` : "";
    return `📊 Budget alert — workspace spend crossed ${pct}${cap}${spend}. Runs continue until the cap.${view}`;
  }
  // Slack treats the top-level `text` as mrkdwn too (it's the fallback/notification line some
  // clients show), so escape the interpolated user values — NOT the URLs, which must stay intact.
  // codeText (escape + backtick neutralization), not bare slackEscape: an odd backtick in a
  // workflow key opens a code span that swallows the rest of the line, including the link.
  const wf = input.workflowKey
    ? `"${codeText(input.workflowKey)}"`
    : "a workflow";
  if (input.kind === "promotion") {
    const envs =
      input.fromEnv && input.toEnv
        ? ` ${slackEscape(input.fromEnv)} → ${slackEscape(input.toEnv)}`
        : "";
    const ver = input.version !== undefined ? ` (v${input.version})` : "";
    const view = links.workflowUrl ? ` View: ${links.workflowUrl}` : "";
    return `🚀 ${wf} promoted${envs}${ver}.${view}`;
  }
  if (input.kind === "fix_proposal") {
    const why = input.title ? ` after ${slackEscape(input.title)}` : "";
    const review = links.approvalUrl ? ` Review: ${links.approvalUrl}` : "";
    // States the guarantee in the message itself. Someone reading this in Slack should not have
    // to wonder whether their workflow has already been changed.
    return `🛠 A fix is proposed for ${wf}${why}. Nothing is applied until you approve it.${review}`;
  }
  const runId = slackEscape(input.workflowId);
  if (input.kind === "approval_pending") {
    const decide = links.approvalUrl
      ? ` Approve or reject: ${links.approvalUrl}`
      : "";
    const gate = `${wf}${input.title ? `: ${slackEscape(input.title)}` : ""} (run ${runId})`;
    if (input.flavor === "reminder") {
      const n = input.reminderIndex ? ` #${input.reminderIndex}` : "";
      return `⏰ Reminder${n} — approval still needed on ${gate}.${decide}`;
    }
    if (input.flavor === "escalation") {
      const target = input.escalateTo
        ? ` to ${slackEscape(input.escalateTo)}`
        : "";
      return `🚨 Approval escalated${target} — still undecided on ${gate}.${decide}`;
    }
    return `⏳ Approval needed on ${gate}.${decide}`;
  }
  // The fallback line carries the SAME facts as the blocks (error type, failing step, reason) —
  // it is what a mobile push preview and every generic hook show. Same suppression + truncation
  // rule via notificationDetail, so an unbounded error message can't run away here either.
  const reason = notificationDetail(input);
  const why = [
    input.errorType ? codeText(input.errorType) : undefined,
    input.failedNodeId ? `at step ${codeText(input.failedNodeId)}` : undefined,
    reason ? codeText(reason) : undefined,
  ].filter(Boolean);
  return `❌ ${wf} run failed${why.length > 0 ? ` (${why.join(" · ")})` : ""} — run ${runId}.${links.runUrl ? ` View: ${links.runUrl}` : ""}`;
}

/** One styled run of text inside a headline. The style is SEMANTIC, not a markup fragment:
 *  `strong` = the thing the sentence is about, `code` = a machine token (an error type, a node
 *  id), `em` = the "unnamed workflow" fallback. Each medium decides how to draw it. */
export interface HeadlineSpan {
  text: string;
  style?: "strong" | "em" | "code";
}

/** A headline as LINES of spans — medium-independent. See `notificationHeadlineModel`. */
export type HeadlineLine = HeadlineSpan[];

const plain = (text: string): HeadlineSpan => ({ text });
const strong = (text: string): HeadlineSpan => ({ text, style: "strong" });
const em = (text: string): HeadlineSpan => ({ text, style: "em" });
const code = (text: string): HeadlineSpan => ({ text, style: "code" });

/** What we call a workflow we have no key for. One constant so the subject line can tell
 *  "the headline named the workflow" from "the headline had nothing to name". */
const UNNAMED_WORKFLOW = "an unnamed workflow";

/**
 * The HEADLINE as DATA: the sentence a human reads, with nothing medium-specific in it.
 *
 * There is exactly ONE of these, and three renderers over it — Slack mrkdwn, plain text and
 * HTML (#1059). The alternative, converting one rendering into another, cannot work: the Slack
 * rendering is lossy and pre-escaped for the wrong medium (a backtick becomes `ʼ`, `&` becomes
 * `&amp;`), so an email built from it would show the reader OUR escaping instead of their data.
 * And the other alternative — a second sentence written for email — is the drift bug this repo
 * keeps paying for (#982, #984, #1005, #1050).
 */
export function notificationHeadlineModel(
  input: NotificationInput,
): HeadlineLine[] {
  const name = input.workflowKey
    ? strong(input.workflowKey)
    : em(UNNAMED_WORKFLOW);

  if (input.kind === "budget_threshold") {
    const cap = input.capUsd !== undefined ? strong(usd(input.capUsd)) : null;
    const spend =
      input.spendUsd !== undefined ? strong(usd(input.spendUsd)) : null;
    const line: HeadlineLine =
      spend && cap
        ? [
            plain("Workspace spend is "),
            spend,
            plain(" of the "),
            cap,
            plain(" monthly cap."),
          ]
        : spend
          ? [plain("Workspace spend is "), spend, plain(" this month.")]
          : cap
            ? [
                plain("Workspace spend crossed the alert threshold on the "),
                cap,
                plain(" monthly cap."),
              ]
            : [plain("Workspace spend crossed the alert threshold.")];
    // Say what does NOT happen. An alert that reads as "your runs just stopped" costs a
    // support ticket; runs continue until the cap itself.
    return [line, [plain("Runs keep running until the cap is reached.")]];
  }

  if (input.kind === "promotion") {
    const ver =
      input.version !== undefined ? strong(`v${input.version}`) : null;
    const to = input.toEnv ? strong(input.toEnv) : null;
    if (ver && to)
      return [[name, plain(" is now "), ver, plain(" in "), to, plain(".")]];
    if (to) return [[name, plain(" is now live in "), to, plain(".")]];
    if (ver) return [[name, plain(" is now "), ver, plain(".")]];
    return [[name, plain(" was promoted.")]];
  }

  if (input.kind === "fix_proposal") {
    const line: HeadlineLine = [name];
    if (input.title) line.push(plain(" — "), plain(input.title));
    // The guarantee lives in the message body, not only in the fallback text: someone reading
    // this on their phone must not have to open the app to learn whether prod already changed.
    return [line, [plain("Nothing is applied until you approve it.")]];
  }

  if (input.kind === "approval_pending") {
    const line: HeadlineLine = [name];
    if (input.title) line.push(plain(" — "), plain(input.title));
    // Escalation flavor: name the target on its own line — it is WHO must act, not a label/value.
    return input.flavor === "escalation" && input.escalateTo
      ? [line, [plain("Escalated to "), strong(input.escalateTo)]]
      : [line];
  }

  // run_failed — the whole point of the alert: WHAT failed, of WHICH type, at WHICH step.
  const detail = notificationDetail(input);
  const line: HeadlineLine = [name];
  if (input.errorType) line.push(plain(" — "), code(input.errorType));
  if (input.failedNodeId)
    line.push(plain(" at step "), code(input.failedNodeId));
  if (!detail) return [line];
  // A short reason with no error type reads better inline ("… — budget_exceeded"); a real
  // error message gets its own line rather than a run-on headline.
  if (!input.errorType && detail.length <= 60) {
    line.push(plain(" — "), plain(detail));
    return [line];
  }
  return [line, [plain(detail)]];
}

/**
 * The HEADLINE under the Slack header: one or two lines of prose a human reads left-to-right.
 *
 * This replaces the `*Label*\nvalue` FIELDS GRID (#987). Slack lays a section's `fields` array
 * out as a two-column table, so a message built from fields renders as a FORM — and a 48-char
 * run id in a half-width column wraps onto two lines, which is most of what made the old
 * message look broken. Nothing here is a grid: the facts are said in a sentence, and the
 * machine-shaped ones move to the small grey context line below.
 *
 * `codeText` on EVERY span (not just user values): mrkdwn control chars and backticks are unsafe
 * wherever they appear, and our own literals contain none, so a blanket escape is both correct
 * and one less rule to get wrong.
 */
export function notificationHeadline(input: NotificationInput): string {
  return notificationHeadlineModel(input)
    .map((line) =>
      line
        .map((s) => {
          const t = codeText(s.text);
          if (s.style === "strong") return `*${t}*`;
          if (s.style === "em") return `_${t}_`;
          if (s.style === "code") return `\`${t}\``;
          return t;
        })
        .join(""),
    )
    .join("\n");
}

/**
 * The headline for a text/plain body (#1059): the words, and nothing else. No markers — `*bold*`
 * in a plaintext mail is just noise — and NO escaping: text/plain is not markup, so a `&` the
 * user typed must arrive as `&`, not `&amp;`.
 */
export function notificationHeadlineText(input: NotificationInput): string {
  return notificationHeadlineModel(input)
    .map((line) => line.map((s) => s.text).join(""))
    .join("\n");
}

/** Inline `<code>` styling for the HTML mail. Inline because mail clients strip `<style>`. */
const HTML_CODE_STYLE =
  "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:#f0f2f4;border-radius:4px;padding:1px 4px;";

/**
 * The headline for an HTML mail body (#1059): real emphasis elements, `htmlEscape` per SPAN, and
 * `<br />` BETWEEN lines. Escaping each span separately (rather than escaping a joined string) is
 * what keeps the line break a break instead of a literal newline the client collapses away.
 */
export function notificationHeadlineHtml(input: NotificationInput): string {
  return notificationHeadlineModel(input)
    .map((line) =>
      line
        .map((s) => {
          const t = htmlEscape(s.text);
          if (s.style === "strong") return `<strong>${t}</strong>`;
          if (s.style === "em") return `<em>${t}</em>`;
          if (s.style === "code")
            return `<code style="${HTML_CODE_STYLE}">${t}</code>`;
          return t;
        })
        .join(""),
    )
    .join("<br />");
}

/**
 * The small grey `context` line: the machine facts a reader wants AVAILABLE but should not have
 * to read FIRST — the run id (truncated, see `shortId`), the source environment. Undefined when
 * a kind has nothing of the sort: `fix_proposal` and `promotion` carry the workflow KEY in
 * `workflowId` and have no run at all, so a "Run …" line there would be a lie.
 */
export function notificationContext(
  input: NotificationInput,
): string | undefined {
  if (input.kind === "run_failed" || input.kind === "approval_pending")
    return `Run \`${codeText(shortId(input.workflowId))}\``;
  if (input.kind === "promotion")
    return input.fromEnv
      ? `Promoted from *${codeText(input.fromEnv)}*`
      : undefined;
  if (input.kind === "budget_threshold") {
    const parts: string[] = [];
    if (input.thresholdPct !== undefined)
      parts.push(`Alert threshold ${input.thresholdPct}%`);
    if (input.spendUsd !== undefined) parts.push("spend includes reserved");
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }
  return undefined;
}

/**
 * Slack Block Kit blocks: a header + a prose headline `section` + a small grey `context` line +
 * an `actions` row of link-buttons (Approve/Reject, View run). Slack renders `blocks` when
 * present; generic/Teams hooks fall back to the top-level `text` + the flat fields. Buttons
 * carry absolute `url`s, so no Slack interactivity wiring is needed.
 *
 * Deliberately NO `fields` array anywhere and no id-as-link-label (#987): `fields` is what
 * Slack renders as a two-column form, and the only place a run id appears is the context line,
 * truncated. The button reads "View run" — a label, not a UUID.
 */
export function notificationBlocks(
  input: NotificationInput,
  links: NotificationLinks,
): { blocks: unknown[]; actions: NotificationAction[] } {
  const actions = notificationActions(input, links);

  const blocks: unknown[] = [
    {
      type: "header",
      // header is plain_text only; unicode emoji render with emoji:true.
      text: {
        type: "plain_text",
        text: notificationHeader(input),
        emoji: true,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: notificationHeadline(input) },
    },
  ];
  const context = notificationContext(input);
  if (context)
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: context }],
    });
  if (actions.length)
    blocks.push({
      type: "actions",
      elements: actions.map((a, i) => ({
        type: "button",
        // Slack rejects an actions block whose buttons lack an action_id (invalid_blocks),
        // even for url-only buttons — derive a stable one from the label.
        action_id: `${a.label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${i}`,
        // emoji:true so the ✅/❌ in the label render as icons on the buttons.
        text: { type: "plain_text", text: a.label, emoji: true },
        url: a.url,
        ...(a.style ? { style: a.style } : {}),
      })),
    });
  return { blocks, actions };
}

/**
 * Microsoft Teams payload: an Adaptive Card wrapped in the {type:"message",attachments:[…]}
 * envelope a Teams Workflows / Incoming-Webhook renders (the legacy MessageCard connector is
 * retiring). Same header + facts + Approve/Reject/View-run buttons as Slack, but as an
 * Adaptive Card — FactSet facts are PLAIN JSON strings (NOT mrkdwn, so no slackEscape — that
 * would double-encode into visible `&amp;`), and links are `Action.OpenUrl` (Teams supports
 * OpenUrl/ShowCard/ToggleVisibility, NOT Action.Submit). Shape verified against Microsoft's
 * docs; not yet verified against a live Teams tenant (use the settings "send test" path).
 */
/**
 * The notification's facts as PLAIN title/value strings (no mrkdwn, no escaping) —
 * shared by the Teams Adaptive Card FactSet and the email renderings so the two can't
 * drift. Callers escape per their own medium (Teams: none — plain JSON; email HTML:
 * htmlEscape).
 */
export function notificationFacts(
  input: NotificationInput,
): { title: string; value: string }[] {
  const isApproval = input.kind === "approval_pending";
  // budget_threshold: tenant-scoped facts (cap/spend/threshold) — no workflow/run pair.
  // promotion: workflow/version + from/to env facts — there is no run at all.
  const facts: { title: string; value: string }[] =
    input.kind === "budget_threshold"
      ? [
          ...(input.thresholdPct !== undefined
            ? [{ title: "Threshold", value: `${input.thresholdPct}%` }]
            : []),
          ...(input.capUsd !== undefined
            ? [{ title: "Monthly cap", value: usd(input.capUsd) }]
            : []),
          ...(input.spendUsd !== undefined
            ? [{ title: "Spend (incl. reserved)", value: usd(input.spendUsd) }]
            : []),
        ]
      : input.kind === "promotion"
        ? [
            { title: "Workflow", value: input.workflowKey ?? "(unnamed)" },
            ...(input.fromEnv ? [{ title: "From", value: input.fromEnv }] : []),
            ...(input.toEnv ? [{ title: "To", value: input.toEnv }] : []),
            ...(input.version !== undefined
              ? [{ title: "Version", value: `v${input.version}` }]
              : []),
          ]
        : input.kind === "fix_proposal"
          ? [
              // No Run fact: `workflowId` is the KEY here (there is no run), so the old
              // "Run: pagerduty-triage" was a lie — and the failure it proposes a fix for,
              // which the reader actually needs, never made it into the card at all.
              { title: "Workflow", value: input.workflowKey ?? "(unnamed)" },
              ...(input.title
                ? [{ title: "Proposed fix for", value: input.title }]
                : []),
            ]
          : [
              { title: "Workflow", value: input.workflowKey ?? "(unnamed)" },
              // Teams/email render facts as a table, not a chat line — the FULL id is useful
              // there (copy/paste into a support thread) and costs no layout.
              { title: "Run", value: input.workflowId },
              ...(input.kind === "run_failed" && input.failedNodeId
                ? [{ title: "Failed step", value: input.failedNodeId }]
                : []),
              ...(input.kind === "run_failed" && input.errorType
                ? [{ title: "Error", value: input.errorType }]
                : []),
            ];
  if (isApproval && input.title)
    facts.push({ title: "Awaiting", value: input.title });
  // Flavor facts (plain strings — neither medium wants mrkdwn here).
  if (isApproval && input.flavor === "reminder" && input.reminderIndex)
    facts.push({ title: "Reminder", value: `#${input.reminderIndex}` });
  if (isApproval && input.flavor === "escalation" && input.escalateTo)
    facts.push({ title: "Escalated to", value: input.escalateTo });
  // ONE reason rule for every surface (#987) — a `Reason: failed` that only restates the header
  // is suppressed here too, so Teams and email can't drift back to it.
  const reason = notificationDetail(input);
  if (reason) facts.push({ title: "Reason", value: reason });
  return facts;
}

export function notificationTeamsCard(
  input: NotificationInput,
  links: NotificationLinks,
): unknown {
  const facts = notificationFacts(input);

  const body: unknown[] = [
    {
      type: "TextBlock",
      text: notificationHeader(input),
      weight: "Bolder",
      size: "Large",
      wrap: true,
    },
    { type: "FactSet", facts },
  ];

  const actions = notificationActions(input, links).map((a) => ({
    type: "Action.OpenUrl",
    title: a.label,
    url: a.url,
    // Adaptive Card action styles — Teams renders positive (green) / destructive (red).
    ...(a.style === "primary"
      ? { style: "positive" }
      : a.style === "danger"
        ? { style: "destructive" }
        : {}),
  }));

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body,
          ...(actions.length ? { actions } : {}),
        },
      },
    ],
  };
}

/** Build the JSON body for one channel. Teams needs its own Adaptive Card envelope; anything
 *  else (default) gets the Slack/generic payload. Unknown/legacy types fall back to Slack. */
export function notificationPayload(
  input: NotificationInput,
  type: string,
  links: NotificationLinks,
): unknown {
  if (type === "teams") return notificationTeamsCard(input, links);
  const text = notificationText(input, links);
  const { blocks, actions } = notificationBlocks(input, links);
  // `text` is the Slack/generic fallback line; `blocks` render the action buttons in Slack;
  // the flat fields + `actions`/`runUrl` serve generic hooks.
  return {
    text,
    blocks,
    kind: input.kind,
    workflowId: input.workflowId,
    workflowKey: input.workflowKey,
    title: input.title,
    runUrl: links.runUrl,
    actions,
    // Failure facts for generic hooks (a PagerDuty/Opsgenie bridge routes on these): the same
    // suppressed-and-truncated reason the humans see, plus the raw type/step.
    ...(input.kind === "run_failed"
      ? {
          ...(notificationDetail(input)
            ? { detail: notificationDetail(input) }
            : {}),
          ...(input.errorType ? { errorType: input.errorType } : {}),
          ...(input.failedNodeId ? { failedNodeId: input.failedNodeId } : {}),
        }
      : {}),
    ...(input.kind === "approval_pending"
      ? {
          approvalUrl: links.approvalUrl,
          // Generic hooks can branch on the flavor (initial vs reminder vs escalation).
          ...(input.flavor ? { flavor: input.flavor } : {}),
          ...(input.reminderIndex !== undefined
            ? { reminderIndex: input.reminderIndex }
            : {}),
          ...(input.escalateTo ? { escalateTo: input.escalateTo } : {}),
        }
      : {}),
    ...(input.kind === "budget_threshold"
      ? {
          // Generic hooks get the raw figures too (usageUrl mirrors runUrl's role).
          ...(input.thresholdPct !== undefined
            ? { thresholdPct: input.thresholdPct }
            : {}),
          ...(input.capUsd !== undefined ? { capUsd: input.capUsd } : {}),
          ...(input.spendUsd !== undefined ? { spendUsd: input.spendUsd } : {}),
          ...(links.usageUrl ? { usageUrl: links.usageUrl } : {}),
        }
      : {}),
    ...(input.kind === "promotion"
      ? {
          // Generic hooks get the promotion facts raw (workflowUrl mirrors runUrl's role).
          ...(input.fromEnv ? { fromEnv: input.fromEnv } : {}),
          ...(input.toEnv ? { toEnv: input.toEnv } : {}),
          ...(input.version !== undefined ? { version: input.version } : {}),
          ...(links.workflowUrl ? { workflowUrl: links.workflowUrl } : {}),
        }
      : {}),
  };
}

/* ---------------- Email rendering (redesign Slice 4) ---------------- */

/** A rendered email: subject + plain-text body + a simple self-contained HTML body.
 *  The SENDING (SMTP connection, credentials, transport) stays caller-side — this is
 *  pure formatting, same boundary as the Slack/Teams shapes above.
 *
 *  Both bodies matter equally: `text` is what a plaintext client, a "show original" view and
 *  most notification digests render, so a headline that only exists in `html` is half a fix. */
export interface NotificationEmail {
  subject: string;
  text: string;
  html: string;
}

/** Escape the five HTML-sensitive characters so user values (workflow keys, titles,
 *  failure reasons) can't inject markup into the HTML body. `&` first, always. */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline-styled link-button for the HTML body (email clients ignore <style> blocks;
 *  everything is inline and self-contained — no images, no external assets). */
function htmlButton(a: NotificationAction): string {
  const bg =
    a.style === "primary"
      ? "#1f7a4d"
      : a.style === "danger"
        ? "#a13232"
        : "#444c56";
  return `<a href="${htmlEscape(a.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:8px 14px;border-radius:6px;background:${bg};color:#ffffff;text-decoration:none;font-weight:600;">${htmlEscape(a.label)}</a>`;
}

/** How much of the headline a subject may carry. A subject is a scan target, not a body: most
 *  clients show ~70 characters on a desktop and far fewer on a phone, and an unbounded error
 *  message must not run away here any more than it may in the blocks. */
const SUBJECT_DETAIL_MAX = 90;

/**
 * The email subject (#1059).
 *
 * The old rule was `${header} — "${workflowKey}"`, which stopped at the EVENT CATEGORY: every
 * failure of every workflow read the same in an inbox, and the reader had to open the mail to
 * learn what had actually happened. That is #987's "says nothing" complaint one level up, on the
 * one surface where there is no body to clarify it.
 *
 * So the subject now leads with the header — the scannable, filterable event marker, unchanged
 * so existing mail rules keep matching — and then says the SPECIFIC thing, taken from the
 * headline's first line so it cannot drift from the body.
 *
 * Two kinds keep the old shape deliberately: `budget_threshold` and `promotion` headers already
 * interpolate their specific fact (`80% of the monthly cap`, `promoted to prod`), so appending
 * the headline would only restate it.
 */
export function notificationSubject(input: NotificationInput): string {
  const header = notificationHeader(input);
  if (input.kind === "budget_threshold") return header;
  if (input.kind === "promotion")
    return input.workflowKey ? `${header} — "${input.workflowKey}"` : header;
  // Nothing to name: the headline would read "❌ Run failed: an unnamed workflow", which is
  // longer than the header and says less.
  if (!input.workflowKey) return header;
  const [first] = notificationHeadlineModel(input);
  // First line only — an escalation's "Escalated to …" is a second line for a reason, and
  // `oneLine` guarantees the single line a subject header must be.
  return `${header}: ${oneLine(
    first.map((s) => s.text).join(""),
    SUBJECT_DETAIL_MAX,
  )}`;
}

/**
 * Render a notification as an email (subject + text AND html bodies) for every kind and
 * approval flavor. Decide-in-place for email = the SAME signed approve/reject LINKS the
 * Slack buttons carry (via `notificationActions`, so the URLs literally cannot differ) —
 * links are the honest email equivalent of buttons. Facts come from `notificationFacts`,
 * shared with the Teams card.
 */
export function notificationEmail(
  input: NotificationInput,
  links: NotificationLinks,
): NotificationEmail {
  const header = notificationHeader(input);
  const subject = notificationSubject(input);

  const facts = notificationFacts(input);
  const actions = notificationActions(input, links);

  // The headline leads BOTH bodies (#1059). The facts stay, demoted to what they always were:
  // secondary reference detail (the full run id you paste into a support thread), below a
  // sentence that already told the reader what happened.
  const text = [
    header,
    notificationHeadlineText(input),
    "",
    ...facts.map((f) => `${f.title}: ${f.value}`),
    ...(actions.length
      ? ["", ...actions.map((a) => `${a.label}: ${a.url}`)]
      : []),
  ].join("\n");

  const factRows = facts
    .map(
      (f) =>
        `<tr><td style="padding:4px 16px 4px 0;color:#57606a;white-space:nowrap;vertical-align:top;">${htmlEscape(f.title)}</td><td style="padding:4px 0;color:#1f2328;">${htmlEscape(f.value)}</td></tr>`,
    )
    .join("");
  const html = [
    `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;max-width:560px;">`,
    `<h2 style="font-size:17px;margin:0 0 8px;">${htmlEscape(header)}</h2>`,
    // Explicit margins, inline: Outlook applies its own <p> spacing otherwise, and every
    // style here has to survive a client that strips <style> blocks entirely.
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${notificationHeadlineHtml(input)}</p>`,
    factRows
      ? `<table style="border-collapse:collapse;margin:0 0 16px;">${factRows}</table>`
      : "",
    actions.length ? `<div>${actions.map(htmlButton).join("")}</div>` : "",
    `<p style="margin:16px 0 0;font-size:12px;color:#8b949e;">Sent by Naary — manage notification channels in Settings.</p>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, text, html };
}
