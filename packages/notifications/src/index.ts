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
  | "promotion";

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
  /** For run_failed: the terminal status / error type. */
  detail?: string;
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
  const wf = input.workflowKey
    ? `"${slackEscape(input.workflowKey)}"`
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
  return `❌ ${wf} run failed${input.detail ? ` (${slackEscape(input.detail)})` : ""} — run ${runId}.${links.runUrl ? ` View: ${links.runUrl}` : ""}`;
}

/**
 * Slack Block Kit blocks: a header + a fields section (where the run is an actual inline
 * `<url|…>` link, not a bare id reference) + an `actions` row of link-buttons — the
 * "multiple entries" a recipient can act on (Approve/Reject, View run). Slack renders
 * `blocks` when present; generic/Teams hooks fall back to top-level `text` + the flat
 * fields. Buttons carry absolute `url`s, so no Slack interactivity wiring is needed.
 */
export function notificationBlocks(
  input: NotificationInput,
  links: NotificationLinks,
): { blocks: unknown[]; actions: NotificationAction[] } {
  const isApproval = input.kind === "approval_pending";

  const actions = notificationActions(input, links);

  // The run as an ACTUAL clickable link when we have a URL, not a bare id reference. The
  // label is escaped so a workflowId with & < > can't break the `<url|label>` markup (the
  // URL itself is already encodeURIComponent'd by runUrl, so it needs no escaping).
  // Link label: slackEscape (protects the `<url|label>` markup). Bare fallback: codeText, since
  // it sits in a backtick code span where a stray backtick would break the span.
  const runField = links.runUrl
    ? `<${links.runUrl}|run ${slackEscape(input.workflowId)}>`
    : `\`${codeText(input.workflowId)}\``;
  // Only the SHORT key-values go in the 2-column `fields` grid — a workflow key and the run link
  // are half-width-friendly. The free-text Awaiting/Reason (which can be a full sentence) gets its
  // own full-width `section` below instead of being crammed into a half-width grid column (which
  // also left the grid lopsided at an odd field count — the "looks odd" report).
  // budget_threshold is TENANT-scoped: the grid shows cap + spend, not a workflow/run pair
  // (the crossing reservation's run is incidental; the alert is about the monthly budget).
  // promotion is WORKFLOW-scoped: workflow/version + from/to env — there is no run at all.
  const fields: { type: "mrkdwn"; text: string }[] =
    input.kind === "budget_threshold"
      ? [
          {
            type: "mrkdwn",
            text: `*Monthly cap*\n${input.capUsd !== undefined ? usd(input.capUsd) : "—"}`,
          },
          {
            type: "mrkdwn",
            text: `*Spend (incl. reserved)*\n${input.spendUsd !== undefined ? usd(input.spendUsd) : "—"}`,
          },
        ]
      : input.kind === "promotion"
        ? [
            {
              type: "mrkdwn",
              text: `*Workflow*\n${input.workflowKey ? `\`${codeText(input.workflowKey)}\`` : "_unnamed_"}`,
            },
            {
              type: "mrkdwn",
              text: `*Version*\n${input.version !== undefined ? `v${input.version}` : "—"}`,
            },
            {
              type: "mrkdwn",
              text: `*From*\n${input.fromEnv ? slackEscape(input.fromEnv) : "—"}`,
            },
            {
              type: "mrkdwn",
              text: `*To*\n${input.toEnv ? slackEscape(input.toEnv) : "—"}`,
            },
          ]
        : [
            {
              type: "mrkdwn",
              text: `*Workflow*\n${input.workflowKey ? `\`${codeText(input.workflowKey)}\`` : "_unnamed_"}`,
            },
            { type: "mrkdwn", text: `*Run*\n${runField}` },
          ];

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
    { type: "section", fields },
  ];
  if (isApproval && input.title)
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Awaiting*\n${slackEscape(input.title)}` },
    });
  // Escalation flavor: name the target as its own full-width line (the comp's
  // "escalates → @ops-oncall"). Free text, so not crammed into the fields grid.
  if (isApproval && input.flavor === "escalation" && input.escalateTo)
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Escalated to*\n${slackEscape(input.escalateTo)}`,
      },
    });
  if (!isApproval && input.detail)
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Reason*\n\`${codeText(input.detail)}\``,
      },
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
        : [
            { title: "Workflow", value: input.workflowKey ?? "(unnamed)" },
            { title: "Run", value: input.workflowId },
          ];
  if (isApproval && input.title)
    facts.push({ title: "Awaiting", value: input.title });
  // Flavor facts (plain strings — neither medium wants mrkdwn here).
  if (isApproval && input.flavor === "reminder" && input.reminderIndex)
    facts.push({ title: "Reminder", value: `#${input.reminderIndex}` });
  if (isApproval && input.flavor === "escalation" && input.escalateTo)
    facts.push({ title: "Escalated to", value: input.escalateTo });
  if (!isApproval && input.detail)
    facts.push({ title: "Reason", value: input.detail });
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
 *  pure formatting, same boundary as the Slack/Teams shapes above. */
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
  // budget_threshold headers already carry the full story; run/workflow-scoped kinds
  // append the workflow key so subjects are scannable in a crowded inbox.
  const subject =
    input.kind !== "budget_threshold" && input.workflowKey
      ? `${header} — "${input.workflowKey}"`
      : header;

  const facts = notificationFacts(input);
  const actions = notificationActions(input, links);

  const text = [
    header,
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
    `<h2 style="font-size:17px;margin:0 0 12px;">${htmlEscape(header)}</h2>`,
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
