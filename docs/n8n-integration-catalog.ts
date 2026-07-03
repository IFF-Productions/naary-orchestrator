// n8n integration catalog — categorized roadmap/tracking data.
//
// Source of truth: n8n-io/n8n@master `packages/nodes-base/nodes` (built-in nodes only,
// core/flow-control primitives excluded). Regenerate the raw list from the GitHub
// contents API; see docs/n8n-integrations.md for the full unfiltered catalog.
//
// `status` tracks OUR orchestrator's coverage of each integration — update as we build.

export type IntegrationCategory =
  | 'AI & ML'
  | 'Analytics & Monitoring'
  | 'CRM & Sales'
  | 'Calendar & Scheduling'
  | 'Communication & Chat'
  | 'Content & CMS'
  | 'Data Enrichment & Lookup'
  | 'Databases & Storage'
  | 'Design & Media'
  | 'Dev Tools & DevOps'
  | 'E-commerce'
  | 'Forms & Surveys'
  | 'HR & Recruiting'
  | 'IoT & Smart Home'
  | 'Logistics & Shipping'
  | 'Marketing & Email'
  | 'Messaging & Infra'
  | 'Payments & Finance'
  | 'Productivity & Notes'
  | 'Project Management & Tasks'
  | 'Security & Identity'
  | 'Social Media & Content'
  | 'Support & Ticketing';

/** Our build/coverage status for a given integration. */
export type SupportStatus = 'planned' | 'in_progress' | 'supported' | 'wont_support';

export interface Integration {
  /** Display name. */
  name: string;
  /** Stable kebab-case id. */
  slug: string;
  category: IntegrationCategory;
  /** Our coverage. Defaults to 'planned' — nothing built yet. */
  status: SupportStatus;
}

export const N8N_INTEGRATIONS: Integration[] = [
  // ── AI & ML (9)
  { name: 'DeepL', slug: 'deep-l', category: 'AI & ML', status: 'planned' },
  { name: 'Humantic AI', slug: 'humantic-a-i', category: 'AI & ML', status: 'planned' },
  { name: 'Jina AI', slug: 'jina-a-i', category: 'AI & ML', status: 'planned' },
  { name: 'LingvaNex', slug: 'lingva-nex', category: 'AI & ML', status: 'planned' },
  { name: 'Mindee', slug: 'mindee', category: 'AI & ML', status: 'planned' },
  { name: 'Mistral AI', slug: 'mistral-a-i', category: 'AI & ML', status: 'planned' },
  { name: 'OpenAI', slug: 'open-ai', category: 'AI & ML', status: 'planned' },
  { name: 'OpenThesaurus', slug: 'open-thesaurus', category: 'AI & ML', status: 'planned' },
  { name: 'Perplexity', slug: 'perplexity', category: 'AI & ML', status: 'planned' },
  // ── Analytics & Monitoring (11)
  { name: 'Elastic', slug: 'elastic', category: 'Analytics & Monitoring', status: 'planned' },
  { name: 'Grafana', slug: 'grafana', category: 'Analytics & Monitoring', status: 'planned' },
  { name: 'Metabase', slug: 'metabase', category: 'Analytics & Monitoring', status: 'planned' },
  { name: 'Misp', slug: 'misp', category: 'Analytics & Monitoring', status: 'planned' },
  { name: 'PostHog', slug: 'post-hog', category: 'Analytics & Monitoring', status: 'planned' },
  { name: 'ProfitWell', slug: 'profit-well', category: 'Analytics & Monitoring', status: 'planned' },
  { name: 'SecurityScorecard', slug: 'security-scorecard', category: 'Analytics & Monitoring', status: 'planned' },
  { name: 'Segment', slug: 'segment', category: 'Analytics & Monitoring', status: 'planned' },
  { name: 'Sentry.io', slug: 'sentry-io', category: 'Analytics & Monitoring', status: 'planned' },
  { name: 'Splunk', slug: 'splunk', category: 'Analytics & Monitoring', status: 'planned' },
  { name: 'UptimeRobot', slug: 'uptime-robot', category: 'Analytics & Monitoring', status: 'planned' },
  // ── CRM & Sales (16)
  { name: 'ActiveCampaign', slug: 'active-campaign', category: 'CRM & Sales', status: 'planned' },
  { name: 'Affinity', slug: 'affinity', category: 'CRM & Sales', status: 'planned' },
  { name: 'Agile CRM', slug: 'agile-crm', category: 'CRM & Sales', status: 'planned' },
  { name: 'Copper', slug: 'copper', category: 'CRM & Sales', status: 'planned' },
  { name: 'Freshworks CRM', slug: 'freshworks-crm', category: 'CRM & Sales', status: 'planned' },
  { name: 'Gong', slug: 'gong', category: 'CRM & Sales', status: 'planned' },
  { name: 'HighLevel', slug: 'high-level', category: 'CRM & Sales', status: 'planned' },
  { name: 'HubSpot', slug: 'hubspot', category: 'CRM & Sales', status: 'planned' },
  { name: 'Keap', slug: 'keap', category: 'CRM & Sales', status: 'planned' },
  { name: 'LoneScale', slug: 'lone-scale', category: 'CRM & Sales', status: 'planned' },
  { name: 'Monica CRM', slug: 'monica-crm', category: 'CRM & Sales', status: 'planned' },
  { name: 'Odoo', slug: 'odoo', category: 'CRM & Sales', status: 'planned' },
  { name: 'Pipedrive', slug: 'pipedrive', category: 'CRM & Sales', status: 'planned' },
  { name: 'Salesforce', slug: 'salesforce', category: 'CRM & Sales', status: 'planned' },
  { name: 'Salesmate', slug: 'salesmate', category: 'CRM & Sales', status: 'planned' },
  { name: 'Zoho CRM', slug: 'zoho', category: 'CRM & Sales', status: 'planned' },
  // ── Calendar & Scheduling (3)
  { name: 'AcuityScheduling', slug: 'acuity-scheduling', category: 'Calendar & Scheduling', status: 'planned' },
  { name: 'Cal.com', slug: 'cal', category: 'Calendar & Scheduling', status: 'planned' },
  { name: 'Calendly', slug: 'calendly', category: 'Calendar & Scheduling', status: 'planned' },
  // ── Communication & Chat (28)
  { name: 'Cisco', slug: 'cisco', category: 'Communication & Chat', status: 'planned' },
  { name: 'Currents', slug: 'currents', category: 'Communication & Chat', status: 'planned' },
  { name: 'Discord', slug: 'discord', category: 'Communication & Chat', status: 'planned' },
  { name: 'Discourse', slug: 'discourse', category: 'Communication & Chat', status: 'planned' },
  { name: 'Gotify', slug: 'gotify', category: 'Communication & Chat', status: 'planned' },
  { name: 'Line', slug: 'line', category: 'Communication & Chat', status: 'planned' },
  { name: 'Matrix', slug: 'matrix', category: 'Communication & Chat', status: 'planned' },
  { name: 'Mattermost', slug: 'mattermost', category: 'Communication & Chat', status: 'planned' },
  { name: 'MessageBird', slug: 'message-bird', category: 'Communication & Chat', status: 'planned' },
  { name: 'Mocean', slug: 'mocean', category: 'Communication & Chat', status: 'planned' },
  { name: 'MSG91', slug: 'msg91', category: 'Communication & Chat', status: 'planned' },
  { name: 'Netscaler', slug: 'netscaler', category: 'Communication & Chat', status: 'planned' },
  { name: 'Plivo', slug: 'plivo', category: 'Communication & Chat', status: 'planned' },
  { name: 'Pushbullet', slug: 'pushbullet', category: 'Communication & Chat', status: 'planned' },
  { name: 'Pushcut', slug: 'pushcut', category: 'Communication & Chat', status: 'planned' },
  { name: 'Pushover', slug: 'pushover', category: 'Communication & Chat', status: 'planned' },
  { name: 'Rocket.Chat', slug: 'rocketchat', category: 'Communication & Chat', status: 'planned' },
  { name: 'SIGNL4', slug: 'signl4', category: 'Communication & Chat', status: 'planned' },
  { name: 'Slack', slug: 'slack', category: 'Communication & Chat', status: 'planned' },
  { name: 'Sms77', slug: 'sms77', category: 'Communication & Chat', status: 'planned' },
  { name: 'Telegram', slug: 'telegram', category: 'Communication & Chat', status: 'planned' },
  { name: 'Twake', slug: 'twake', category: 'Communication & Chat', status: 'planned' },
  { name: 'Twilio', slug: 'twilio', category: 'Communication & Chat', status: 'planned' },
  { name: 'Twist', slug: 'twist', category: 'Communication & Chat', status: 'planned' },
  { name: 'Vonage', slug: 'vonage', category: 'Communication & Chat', status: 'planned' },
  { name: 'WhatsApp Business', slug: 'whats-app', category: 'Communication & Chat', status: 'planned' },
  { name: 'Zoom', slug: 'zoom', category: 'Communication & Chat', status: 'planned' },
  { name: 'Zulip', slug: 'zulip', category: 'Communication & Chat', status: 'planned' },
  // ── Content & CMS (4)
  { name: 'Cockpit', slug: 'cockpit', category: 'Content & CMS', status: 'planned' },
  { name: 'Contentful', slug: 'contentful', category: 'Content & CMS', status: 'planned' },
  { name: 'Storyblok', slug: 'storyblok', category: 'Content & CMS', status: 'planned' },
  { name: 'Strapi', slug: 'strapi', category: 'Content & CMS', status: 'planned' },
  // ── Data Enrichment & Lookup (9)
  { name: 'Airtop', slug: 'airtop', category: 'Data Enrichment & Lookup', status: 'planned' },
  { name: 'Bitly', slug: 'bitly', category: 'Data Enrichment & Lookup', status: 'planned' },
  { name: 'Marketstack', slug: 'marketstack', category: 'Data Enrichment & Lookup', status: 'planned' },
  { name: 'Nasa', slug: 'nasa', category: 'Data Enrichment & Lookup', status: 'planned' },
  { name: 'OpenWeatherMap', slug: 'open-weather-map', category: 'Data Enrichment & Lookup', status: 'planned' },
  { name: 'Peekalink', slug: 'peekalink', category: 'Data Enrichment & Lookup', status: 'planned' },
  { name: 'UpLead', slug: 'uplead', category: 'Data Enrichment & Lookup', status: 'planned' },
  { name: 'uProc', slug: 'u-proc', category: 'Data Enrichment & Lookup', status: 'planned' },
  { name: 'YOURLS', slug: 'yourls', category: 'Data Enrichment & Lookup', status: 'planned' },
  // ── Databases & Storage (21)
  { name: 'Airtable', slug: 'airtable', category: 'Databases & Storage', status: 'planned' },
  { name: 'AWS', slug: 'aws', category: 'Databases & Storage', status: 'planned' },
  { name: 'Baserow', slug: 'baserow', category: 'Databases & Storage', status: 'planned' },
  { name: 'CrateDB', slug: 'crate-db', category: 'Databases & Storage', status: 'planned' },
  { name: 'Databricks', slug: 'databricks', category: 'Databases & Storage', status: 'planned' },
  { name: 'FileMaker', slug: 'file-maker', category: 'Databases & Storage', status: 'planned' },
  { name: 'Grist', slug: 'grist', category: 'Databases & Storage', status: 'planned' },
  { name: 'MongoDB', slug: 'mongo-db', category: 'Databases & Storage', status: 'planned' },
  { name: 'MySQL', slug: 'my-sql', category: 'Databases & Storage', status: 'planned' },
  { name: 'NocoDB', slug: 'noco-d-b', category: 'Databases & Storage', status: 'planned' },
  { name: 'Oracle', slug: 'oracle', category: 'Databases & Storage', status: 'planned' },
  { name: 'Postgres', slug: 'postgres', category: 'Databases & Storage', status: 'planned' },
  { name: 'QuestDB', slug: 'quest-db', category: 'Databases & Storage', status: 'planned' },
  { name: 'QuickBase', slug: 'quick-base', category: 'Databases & Storage', status: 'planned' },
  { name: 'Redis', slug: 'redis', category: 'Databases & Storage', status: 'planned' },
  { name: 'S3', slug: 's3', category: 'Databases & Storage', status: 'planned' },
  { name: 'SeaTable', slug: 'sea-table', category: 'Databases & Storage', status: 'planned' },
  { name: 'Snowflake', slug: 'snowflake', category: 'Databases & Storage', status: 'planned' },
  { name: 'Stackby', slug: 'stackby', category: 'Databases & Storage', status: 'planned' },
  { name: 'Supabase', slug: 'supabase', category: 'Databases & Storage', status: 'planned' },
  { name: 'TimescaleDB', slug: 'timescale-db', category: 'Databases & Storage', status: 'planned' },
  // ── Design & Media (4)
  { name: 'APITemplate.io', slug: 'api-template-io', category: 'Design & Media', status: 'planned' },
  { name: 'Bannerbear', slug: 'bannerbear', category: 'Design & Media', status: 'planned' },
  { name: 'Figma', slug: 'figma', category: 'Design & Media', status: 'planned' },
  { name: 'QuickChart', slug: 'quick-chart', category: 'Design & Media', status: 'planned' },
  // ── Dev Tools & DevOps (16)
  { name: 'Adalo', slug: 'adalo', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'Bitbucket', slug: 'bitbucket', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'Bubble', slug: 'bubble', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'CircleCI', slug: 'circle-ci', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'Cortex', slug: 'cortex', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'Git', slug: 'git', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'GitHub', slug: 'github', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'GitLab', slug: 'gitlab', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'Jenkins', slug: 'jenkins', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'N8n', slug: 'n8n', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'Netlify', slug: 'netlify', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'Npm', slug: 'npm', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'PostBin', slug: 'post-bin', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'Rundeck', slug: 'rundeck', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'Travis CI', slug: 'travis-ci', category: 'Dev Tools & DevOps', status: 'planned' },
  { name: 'Webflow', slug: 'webflow', category: 'Dev Tools & DevOps', status: 'planned' },
  // ── E-commerce (4)
  { name: 'Gumroad', slug: 'gumroad', category: 'E-commerce', status: 'planned' },
  { name: 'Magento', slug: 'magento', category: 'E-commerce', status: 'planned' },
  { name: 'Shopify', slug: 'shopify', category: 'E-commerce', status: 'planned' },
  { name: 'WooCommerce', slug: 'woo-commerce', category: 'E-commerce', status: 'planned' },
  // ── Forms & Surveys (10)
  { name: 'Demio', slug: 'demio', category: 'Forms & Surveys', status: 'planned' },
  { name: 'Eventbrite', slug: 'eventbrite', category: 'Forms & Surveys', status: 'planned' },
  { name: 'Form.io', slug: 'form-io', category: 'Forms & Surveys', status: 'planned' },
  { name: 'Formstack', slug: 'formstack', category: 'Forms & Surveys', status: 'planned' },
  { name: 'GoTo Webinar', slug: 'go-to-webinar', category: 'Forms & Surveys', status: 'planned' },
  { name: 'JotForm', slug: 'jot-form', category: 'Forms & Surveys', status: 'planned' },
  { name: 'KoBoToolbox', slug: 'ko-bo-toolbox', category: 'Forms & Surveys', status: 'planned' },
  { name: 'SurveyMonkey', slug: 'survey-monkey', category: 'Forms & Surveys', status: 'planned' },
  { name: 'Typeform', slug: 'typeform', category: 'Forms & Surveys', status: 'planned' },
  { name: 'Wufoo', slug: 'wufoo', category: 'Forms & Surveys', status: 'planned' },
  // ── HR & Recruiting (2)
  { name: 'BambooHR', slug: 'bamboo-hr', category: 'HR & Recruiting', status: 'planned' },
  { name: 'Workable', slug: 'workable', category: 'HR & Recruiting', status: 'planned' },
  // ── IoT & Smart Home (2)
  { name: 'Home Assistant', slug: 'home-assistant', category: 'IoT & Smart Home', status: 'planned' },
  { name: 'PhilipsHue', slug: 'philips-hue', category: 'IoT & Smart Home', status: 'planned' },
  // ── Logistics & Shipping (2)
  { name: 'Dhl', slug: 'dhl', category: 'Logistics & Shipping', status: 'planned' },
  { name: 'Onfleet', slug: 'onfleet', category: 'Logistics & Shipping', status: 'planned' },
  // ── Marketing & Email (22)
  { name: 'ActionNetwork', slug: 'action-network', category: 'Marketing & Email', status: 'planned' },
  { name: 'Autopilot', slug: 'autopilot', category: 'Marketing & Email', status: 'planned' },
  { name: 'Brevo', slug: 'brevo', category: 'Marketing & Email', status: 'planned' },
  { name: 'ConvertKit', slug: 'convert-kit', category: 'Marketing & Email', status: 'planned' },
  { name: 'Customer.io', slug: 'customer-io', category: 'Marketing & Email', status: 'planned' },
  { name: 'Drift', slug: 'drift', category: 'Marketing & Email', status: 'planned' },
  { name: 'Egoi', slug: 'egoi', category: 'Marketing & Email', status: 'planned' },
  { name: 'Emelia', slug: 'emelia', category: 'Marketing & Email', status: 'planned' },
  { name: 'GetResponse', slug: 'get-response', category: 'Marketing & Email', status: 'planned' },
  { name: 'Iterable', slug: 'iterable', category: 'Marketing & Email', status: 'planned' },
  { name: 'Lemlist', slug: 'lemlist', category: 'Marketing & Email', status: 'planned' },
  { name: 'Mailchimp', slug: 'mailchimp', category: 'Marketing & Email', status: 'planned' },
  { name: 'MailerLite', slug: 'mailer-lite', category: 'Marketing & Email', status: 'planned' },
  { name: 'Mailgun', slug: 'mailgun', category: 'Marketing & Email', status: 'planned' },
  { name: 'Mailjet', slug: 'mailjet', category: 'Marketing & Email', status: 'planned' },
  { name: 'Mandrill', slug: 'mandrill', category: 'Marketing & Email', status: 'planned' },
  { name: 'Mautic', slug: 'mautic', category: 'Marketing & Email', status: 'planned' },
  { name: 'Postmark', slug: 'postmark', category: 'Marketing & Email', status: 'planned' },
  { name: 'SendGrid', slug: 'send-grid', category: 'Marketing & Email', status: 'planned' },
  { name: 'Sendy', slug: 'sendy', category: 'Marketing & Email', status: 'planned' },
  { name: 'Tapfiliate', slug: 'tapfiliate', category: 'Marketing & Email', status: 'planned' },
  { name: 'Vero', slug: 'vero', category: 'Marketing & Email', status: 'planned' },
  // ── Messaging & Infra (5)
  { name: 'AMQP', slug: 'amqp', category: 'Messaging & Infra', status: 'planned' },
  { name: 'FTP', slug: 'ftp', category: 'Messaging & Infra', status: 'planned' },
  { name: 'Kafka', slug: 'kafka', category: 'Messaging & Infra', status: 'planned' },
  { name: 'MQTT', slug: 'm-q-t-t', category: 'Messaging & Infra', status: 'planned' },
  { name: 'RabbitMQ', slug: 'rabbit-m-q', category: 'Messaging & Infra', status: 'planned' },
  // ── Payments & Finance (10)
  { name: 'Chargebee', slug: 'chargebee', category: 'Payments & Finance', status: 'planned' },
  { name: 'CoinGecko', slug: 'coin-gecko', category: 'Payments & Finance', status: 'planned' },
  { name: 'Invoice Ninja', slug: 'invoice-ninja', category: 'Payments & Finance', status: 'planned' },
  { name: 'Paddle', slug: 'paddle', category: 'Payments & Finance', status: 'planned' },
  { name: 'PayPal', slug: 'pay-pal', category: 'Payments & Finance', status: 'planned' },
  { name: 'QuickBooks', slug: 'quick-books', category: 'Payments & Finance', status: 'planned' },
  { name: 'Stripe', slug: 'stripe', category: 'Payments & Finance', status: 'planned' },
  { name: 'Unleashed Software', slug: 'unleashed-software', category: 'Payments & Finance', status: 'planned' },
  { name: 'Wise', slug: 'wise', category: 'Payments & Finance', status: 'planned' },
  { name: 'Xero', slug: 'xero', category: 'Payments & Finance', status: 'planned' },
  // ── Productivity & Notes (12)
  { name: 'Beeminder', slug: 'beeminder', category: 'Productivity & Notes', status: 'planned' },
  { name: 'Box', slug: 'box', category: 'Productivity & Notes', status: 'planned' },
  { name: 'Coda', slug: 'coda', category: 'Productivity & Notes', status: 'planned' },
  { name: 'Dropbox', slug: 'dropbox', category: 'Productivity & Notes', status: 'planned' },
  { name: 'Ghost', slug: 'ghost', category: 'Productivity & Notes', status: 'planned' },
  { name: 'Google', slug: 'google', category: 'Productivity & Notes', status: 'planned' },
  { name: 'Medium', slug: 'medium', category: 'Productivity & Notes', status: 'planned' },
  { name: 'Microsoft', slug: 'microsoft', category: 'Productivity & Notes', status: 'planned' },
  { name: 'Nextcloud', slug: 'next-cloud', category: 'Productivity & Notes', status: 'planned' },
  { name: 'Notion', slug: 'notion', category: 'Productivity & Notes', status: 'planned' },
  { name: 'One Simple API', slug: 'one-simple-api', category: 'Productivity & Notes', status: 'planned' },
  { name: 'Oura', slug: 'oura', category: 'Productivity & Notes', status: 'planned' },
  // ── Project Management & Tasks (13)
  { name: 'Asana', slug: 'asana', category: 'Project Management & Tasks', status: 'planned' },
  { name: 'ClickUp', slug: 'click-up', category: 'Project Management & Tasks', status: 'planned' },
  { name: 'Clockify', slug: 'clockify', category: 'Project Management & Tasks', status: 'planned' },
  { name: 'Flow', slug: 'flow', category: 'Project Management & Tasks', status: 'planned' },
  { name: 'Harvest', slug: 'harvest', category: 'Project Management & Tasks', status: 'planned' },
  { name: 'Jira', slug: 'jira', category: 'Project Management & Tasks', status: 'planned' },
  { name: 'Linear', slug: 'linear', category: 'Project Management & Tasks', status: 'planned' },
  { name: 'monday.com', slug: 'monday-com', category: 'Project Management & Tasks', status: 'planned' },
  { name: 'Taiga', slug: 'taiga', category: 'Project Management & Tasks', status: 'planned' },
  { name: 'Todoist', slug: 'todoist', category: 'Project Management & Tasks', status: 'planned' },
  { name: 'Toggl', slug: 'toggl', category: 'Project Management & Tasks', status: 'planned' },
  { name: 'Trello', slug: 'trello', category: 'Project Management & Tasks', status: 'planned' },
  { name: 'Wekan', slug: 'wekan', category: 'Project Management & Tasks', status: 'planned' },
  // ── Security & Identity (10)
  { name: 'Bitwarden', slug: 'bitwarden', category: 'Security & Identity', status: 'planned' },
  { name: 'Clearbit', slug: 'clearbit', category: 'Security & Identity', status: 'planned' },
  { name: 'Cloudflare', slug: 'cloudflare', category: 'Security & Identity', status: 'planned' },
  { name: 'Dropcontact', slug: 'dropcontact', category: 'Security & Identity', status: 'planned' },
  { name: 'Hunter', slug: 'hunter', category: 'Security & Identity', status: 'planned' },
  { name: 'LDAP', slug: 'ldap', category: 'Security & Identity', status: 'planned' },
  { name: 'Mailcheck', slug: 'mailcheck', category: 'Security & Identity', status: 'planned' },
  { name: 'Okta', slug: 'okta', category: 'Security & Identity', status: 'planned' },
  { name: 'urlscan.io', slug: 'url-scan-io', category: 'Security & Identity', status: 'planned' },
  { name: 'Venafi', slug: 'venafi', category: 'Security & Identity', status: 'planned' },
  // ── Social Media & Content (14)
  { name: 'Brandfetch', slug: 'brandfetch', category: 'Social Media & Content', status: 'planned' },
  { name: 'Disqus', slug: 'disqus', category: 'Social Media & Content', status: 'planned' },
  { name: 'Facebook', slug: 'facebook', category: 'Social Media & Content', status: 'planned' },
  { name: 'Facebook Lead Ads', slug: 'facebook-lead-ads', category: 'Social Media & Content', status: 'planned' },
  { name: 'Hacker News', slug: 'hacker-news', category: 'Social Media & Content', status: 'planned' },
  { name: 'LinkedIn', slug: 'linked-in', category: 'Social Media & Content', status: 'planned' },
  { name: 'Orbit', slug: 'orbit', category: 'Social Media & Content', status: 'planned' },
  { name: 'Phantombuster', slug: 'phantombuster', category: 'Social Media & Content', status: 'planned' },
  { name: 'Raindrop', slug: 'raindrop', category: 'Social Media & Content', status: 'planned' },
  { name: 'Reddit', slug: 'reddit', category: 'Social Media & Content', status: 'planned' },
  { name: 'Spotify', slug: 'spotify', category: 'Social Media & Content', status: 'planned' },
  { name: 'Strava', slug: 'strava', category: 'Social Media & Content', status: 'planned' },
  { name: 'Twitter', slug: 'twitter', category: 'Social Media & Content', status: 'planned' },
  { name: 'WordPress', slug: 'wordpress', category: 'Social Media & Content', status: 'planned' },
  // ── Support & Ticketing (13)
  { name: 'ERPNext', slug: 'e-r-p-next', category: 'Support & Ticketing', status: 'planned' },
  { name: 'Freshdesk', slug: 'freshdesk', category: 'Support & Ticketing', status: 'planned' },
  { name: 'Freshservice', slug: 'freshservice', category: 'Support & Ticketing', status: 'planned' },
  { name: 'HaloPSA', slug: 'halo-p-s-a', category: 'Support & Ticketing', status: 'planned' },
  { name: 'Help Scout', slug: 'help-scout', category: 'Support & Ticketing', status: 'planned' },
  { name: 'Intercom', slug: 'intercom', category: 'Support & Ticketing', status: 'planned' },
  { name: 'PagerDuty', slug: 'pager-duty', category: 'Support & Ticketing', status: 'planned' },
  { name: 'ServiceNow', slug: 'service-now', category: 'Support & Ticketing', status: 'planned' },
  { name: 'SyncroMSP', slug: 'syncro-m-s-p', category: 'Support & Ticketing', status: 'planned' },
  { name: 'TheHive', slug: 'the-hive', category: 'Support & Ticketing', status: 'planned' },
  { name: 'TheHive 5', slug: 'the-hive-project', category: 'Support & Ticketing', status: 'planned' },
  { name: 'Zammad', slug: 'zammad', category: 'Support & Ticketing', status: 'planned' },
  { name: 'Zendesk', slug: 'zendesk', category: 'Support & Ticketing', status: 'planned' },
];

/** Category → integrations, in declared order. */
export function integrationsByCategory(): Record<IntegrationCategory, Integration[]> {
  return N8N_INTEGRATIONS.reduce((acc, i) => {
    (acc[i.category] ??= []).push(i);
    return acc;
  }, {} as Record<IntegrationCategory, Integration[]>);
}

/** Count by our coverage status. */
export function coverageSummary(): Record<SupportStatus, number> {
  return N8N_INTEGRATIONS.reduce((acc, i) => {
    acc[i.status] = (acc[i.status] ?? 0) + 1;
    return acc;
  }, {} as Record<SupportStatus, number>);
}
