/**
 * The interpreter's write/read classification for integration actions (#910).
 *
 * WHY THIS EXISTS. `handleIntegration` needs exactly ONE BIT per node — is this action a
 * side-effecting write? — to pick `callIntegrationWrite` (at-most-once, `maximumAttempts: 1`)
 * over `callIntegrationRead` (`maximumAttempts: 3`). It used to answer that with
 * `getIntegrationAction()`, which loaded the entire 161KB catalog — every provider, action,
 * field and UI hint string — into the DETERMINISTIC Temporal workflow bundle that every worker
 * loads and every replay evaluates. This module answers the same bit from a flat literal.
 *
 * WHY IT IS SAFE. Getting this wrong is not a build failure: classifying a WRITE as a READ
 * re-enables retries on a non-idempotent call, i.e. a double-posted incident / email / row. So
 * the set is not maintained by hand-inference — `integration-write-drift.spec.ts` asserts it
 * matches `INTEGRATION_CATALOG` EXACTLY, in both directions:
 *   - every catalog action (all 163 of them, reads included) classifies to its own `write` flag;
 *   - the set contains no key the catalog doesn't have (catches a stale entry for a deleted
 *     action, which iterating the catalog can never see).
 * Adding a catalog action without updating this list fails CI. Regenerate rather than edit by
 * eye — the drift test prints the exact diff.
 *
 * WHY A `Set`, NOT A NESTED RECORD. `WRITES[provider]?.includes(action)` reads the prototype
 * chain: `WRITES["constructor"]` yields `Object`, then `.includes` is not a function → a
 * TypeError thrown inside deterministic workflow code (cf. #591/#766). A `Set` of
 * `"provider/action"` strings has no prototype surface at all. The drift test also asserts no
 * provider or action key contains the `/` delimiter, so the join can never be ambiguous.
 *
 * NO `wf.patched()` GATE IS NEEDED: the drift test guarantees the classification is identical
 * to the old catalog lookup for every known provider/action, and an UNKNOWN pair falls to read
 * on both the old path (`undefined?.write` → falsy) and the new one (`!set.has(...)`). No
 * in-flight history can therefore see a different activity scheduled on replay.
 */
export const INTEGRATION_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  // Airtable
  "airtable/create_record",
  "airtable/update_record",
  // Asana
  "asana/add_comment",
  "asana/create_task",
  "asana/update_task",
  // Box
  "box/create_folder",
  "box/delete_file",
  // Calendly
  "calendly/cancel_event",
  // ClickUp
  "clickup/create_comment",
  "clickup/create_task",
  "clickup/update_task",
  // Cloudflare
  "cloudflare/create_dns_record",
  "cloudflare/delete_dns_record",
  // DigitalOcean
  "digitalocean/create_droplet",
  "digitalocean/delete_droplet",
  // Discord
  "discord/add_reaction",
  "discord/create_dm",
  "discord/send_message",
  // Dropbox
  "dropbox/create_folder",
  "dropbox/delete",
  // Front
  "front/add_comment",
  // GitHub
  "github/add_labels",
  "github/comment_issue",
  "github/create_issue",
  // GitLab
  "gitlab/comment_issue",
  "gitlab/create_issue",
  // Google Sheets
  "googlesheets/append_row",
  "googlesheets/clear_values",
  "googlesheets/update_values",
  // HubSpot
  "hubspot/create_contact",
  "hubspot/create_deal",
  "hubspot/update_contact",
  // Intercom
  "intercom/create_contact",
  "intercom/create_note",
  "intercom/send_message",
  // Jira
  "jira/add_comment",
  "jira/create_issue",
  "jira/transition_issue",
  // Linear
  "linear/create_comment",
  "linear/create_issue",
  "linear/update_issue",
  // Mailchimp
  "mailchimp/add_member",
  "mailchimp/create_campaign",
  "mailchimp/update_member",
  // Mattermost
  "mattermost/add_reaction",
  "mattermost/send_message",
  // Monday.com
  "monday/change_column_value",
  "monday/create_item",
  "monday/create_update",
  // Microsoft Graph
  "msgraph/create_event",
  "msgraph/send_mail",
  // Notion
  "notion/append_block",
  "notion/create_page",
  // PagerDuty
  "pagerduty/acknowledge_incident",
  "pagerduty/add_note",
  "pagerduty/create_incident",
  "pagerduty/resolve_incident",
  // Pipedrive
  "pipedrive/create_deal",
  "pipedrive/create_person",
  "pipedrive/update_deal",
  // PostHog
  "posthog/create_annotation",
  // SendGrid
  "sendgrid/send_mail",
  "sendgrid/upsert_contacts",
  // Sentry
  "sentry/update_issue",
  // Shopify
  "shopify/create_order",
  "shopify/create_product",
  "shopify/update_product",
  // Slack
  "slack/add_reaction",
  "slack/post_message",
  "slack/update_message",
  // Stripe
  "stripe/create_customer",
  "stripe/create_payment_intent",
  "stripe/create_refund",
  // Todoist
  "todoist/close_task",
  "todoist/create_task",
  // Twilio
  "twilio/make_call",
  "twilio/send_sms",
  // Vercel
  "vercel/delete_deployment",
  // Webflow
  "webflow/create_item",
  // Zendesk
  "zendesk/create_ticket",
  "zendesk/create_user",
  "zendesk/update_ticket",
  // Zoom
  "zoom/create_meeting",
  "zoom/delete_meeting",
]);

/**
 * True when `provider`/`action` is a side-effecting write, i.e. must run AT-MOST-ONCE.
 * Total: an unknown provider or action returns false (retryable read), exactly as the
 * previous `getIntegrationAction(...)?.write` lookup did. The save gate (`validateGraph`)
 * is what rejects unknown pairs; this is not the place to fail a run.
 */
export function isIntegrationWriteAction(
  provider: string,
  action: string,
): boolean {
  return INTEGRATION_WRITE_ACTIONS.has(`${provider}/${action}`);
}
