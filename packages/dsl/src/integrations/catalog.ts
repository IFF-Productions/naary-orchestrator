/**
 * The 38 provider files assembled into the one lookup table, plus the palette's provider list.
 *
 * THE KEY ORDER OF THE LITERAL IS DATA, not housekeeping. `INTEGRATION_PROVIDERS` is
 * `Object.values` of it, and that array is the order the tiles appear in the canvas palette and
 * the order `scripts/gen-integration-docs.mjs` writes the provider index into
 * `docs/integrations/README.md`. It is deliberately neither alphabetical nor the order the
 * entries were written in — someone curated it. Add a provider where it belongs in the list;
 * never sort it. (The import list is a different matter: nothing reads that, so it is alphabetical.)
 *
 * This is the module that actually pulls all ~161KB of catalog data, so this is where the #910
 * rule bites hardest: nothing under `apps/worker/src/temporal/workflow/**` may reach it, directly
 * or through the package barrel. `apps/worker/test/workflow-bundle.spec.ts` fails the build if it
 * does — see ../integrations.ts for the full story.
 */
import type { IntegrationProvider } from "./types";
import { AIRTABLE } from "./providers/airtable";
import { ASANA } from "./providers/asana";
import { BOX } from "./providers/box";
import { CALENDLY } from "./providers/calendly";
import { CLICKUP } from "./providers/clickup";
import { CLOUDFLARE } from "./providers/cloudflare";
import { DEEPL } from "./providers/deepl";
import { DIGITALOCEAN } from "./providers/digitalocean";
import { DISCORD } from "./providers/discord";
import { DROPBOX } from "./providers/dropbox";
import { FRONT } from "./providers/front";
import { GITHUB } from "./providers/github";
import { GITLAB } from "./providers/gitlab";
import { GOOGLESHEETS } from "./providers/googlesheets";
import { HUBSPOT } from "./providers/hubspot";
import { INTERCOM } from "./providers/intercom";
import { JIRA } from "./providers/jira";
import { LINEAR } from "./providers/linear";
import { MAILCHIMP } from "./providers/mailchimp";
import { MATTERMOST } from "./providers/mattermost";
import { MONDAY } from "./providers/monday";
import { MSGRAPH } from "./providers/msgraph";
import { NETLIFY } from "./providers/netlify";
import { NOTION } from "./providers/notion";
import { PAGERDUTY } from "./providers/pagerduty";
import { PIPEDRIVE } from "./providers/pipedrive";
import { POSTHOG } from "./providers/posthog";
import { SENDGRID } from "./providers/sendgrid";
import { SENTRY } from "./providers/sentry";
import { SHOPIFY } from "./providers/shopify";
import { SLACK } from "./providers/slack";
import { STRIPE } from "./providers/stripe";
import { TODOIST } from "./providers/todoist";
import { TWILIO } from "./providers/twilio";
import { VERCEL } from "./providers/vercel";
import { WEBFLOW } from "./providers/webflow";
import { ZENDESK } from "./providers/zendesk";
import { ZOOM } from "./providers/zoom";

export const INTEGRATION_CATALOG: Record<string, IntegrationProvider> = {
  mattermost: MATTERMOST,
  pagerduty: PAGERDUTY,
  googlesheets: GOOGLESHEETS,
  deepl: DEEPL,
  stripe: STRIPE,
  shopify: SHOPIFY,
  twilio: TWILIO,
  mailchimp: MAILCHIMP,
  discord: DISCORD,
  linear: LINEAR,
  clickup: CLICKUP,
  monday: MONDAY,
  pipedrive: PIPEDRIVE,
  zendesk: ZENDESK,
  github: GITHUB,
  jira: JIRA,
  slack: SLACK,
  notion: NOTION,
  gitlab: GITLAB,
  hubspot: HUBSPOT,
  sendgrid: SENDGRID,
  airtable: AIRTABLE,
  asana: ASANA,
  todoist: TODOIST,
  calendly: CALENDLY,
  intercom: INTERCOM,
  webflow: WEBFLOW,
  zoom: ZOOM,
  front: FRONT,
  sentry: SENTRY,
  vercel: VERCEL,
  netlify: NETLIFY,
  digitalocean: DIGITALOCEAN,
  cloudflare: CLOUDFLARE,
  posthog: POSTHOG,
  dropbox: DROPBOX,
  msgraph: MSGRAPH,
  box: BOX,
};

/** The node type added to the palette per provider (the tile presets `provider`). */
export const INTEGRATION_PROVIDERS: IntegrationProvider[] =
  Object.values(INTEGRATION_CATALOG);
