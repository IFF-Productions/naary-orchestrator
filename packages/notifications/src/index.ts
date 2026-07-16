/**
 * Pure notification formatters shared by the worker (which SENDS them) and the web app (which
 * PREVIEWS them in Storybook). No `process.env`, no crypto, no I/O — the caller resolves the
 * links and passes them in as data. That boundary is load-bearing: token/URL minting reads
 * `ENCRYPTION_KEY` and must stay worker-side (CLAUDE.md §4), so it never enters this module and
 * therefore never enters the browser bundle.
 */

export type NotificationKind = "approval_pending" | "run_failed";

/** The run facts a notification describes (worker adds `tenantId` upstream; formatting never needs it). */
export interface NotificationInput {
  kind: NotificationKind;
  workflowId: string;
  workflowKey?: string;
  /** For approval_pending: the approval node's title (from the graph). */
  title?: string;
  /** For run_failed: the terminal status / error type. */
  detail?: string;
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

/** Short headline for the notification, shared by the Slack header + the Teams card. */
export function notificationHeader(input: NotificationInput): string {
  return input.kind === "approval_pending"
    ? "⏳ Approval needed"
    : "❌ Run failed";
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
  const wf = input.workflowKey ? `"${input.workflowKey}"` : "a workflow";
  if (input.kind === "approval_pending") {
    return `⏳ Approval needed on ${wf}${input.title ? `: ${input.title}` : ""} (run ${input.workflowId}).${links.approvalUrl ? ` Approve or reject: ${links.approvalUrl}` : ""}`;
  }
  return `❌ ${wf} run failed${input.detail ? ` (${input.detail})` : ""} — run ${input.workflowId}.${links.runUrl ? ` View: ${links.runUrl}` : ""}`;
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
  const runId = slackEscape(input.workflowId);
  const runField = links.runUrl
    ? `<${links.runUrl}|run ${runId}>`
    : `\`${runId}\``;
  // Only the SHORT key-values go in the 2-column `fields` grid — a workflow key and the run link
  // are half-width-friendly. The free-text Awaiting/Reason (which can be a full sentence) gets its
  // own full-width `section` below instead of being crammed into a half-width grid column (which
  // also left the grid lopsided at an odd field count — the "looks odd" report).
  const fields: { type: "mrkdwn"; text: string }[] = [
    {
      type: "mrkdwn",
      text: `*Workflow*\n${input.workflowKey ? `\`${slackEscape(input.workflowKey)}\`` : "_unnamed_"}`,
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
  if (!isApproval && input.detail)
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Reason*\n\`${slackEscape(input.detail)}\``,
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
export function notificationTeamsCard(
  input: NotificationInput,
  links: NotificationLinks,
): unknown {
  const isApproval = input.kind === "approval_pending";
  const facts: { title: string; value: string }[] = [
    { title: "Workflow", value: input.workflowKey ?? "(unnamed)" },
    { title: "Run", value: input.workflowId },
  ];
  if (isApproval && input.title)
    facts.push({ title: "Awaiting", value: input.title });
  if (!isApproval && input.detail)
    facts.push({ title: "Reason", value: input.detail });

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
      ? { approvalUrl: links.approvalUrl }
      : {}),
  };
}
