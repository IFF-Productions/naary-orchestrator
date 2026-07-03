# n8n Integrations — Full Catalog

Compiled from the n8n source tree (`n8n-io/n8n@master`): `packages/nodes-base/nodes` and `packages/@n8n/nodes-langchain/nodes`. This is the built-in node set — it does **not** include the ~2,000+ community nodes published to npm.

**Totals:** 240 third-party app/service integrations · 8 AI-model vendor nodes · 12 AWS sub-services · 21 Google sub-services · 12 Microsoft sub-services · 67 core/flow-control nodes.

---

## App & service integrations (240)

- ActionNetwork
- ActiveCampaign
- AcuityScheduling
- Adalo
- Affinity
- Agile CRM
- Airtable
- Airtop
- AMQP
- APITemplate.io
- Asana
- Autopilot
- AWS
- BambooHR
- Bannerbear
- Baserow
- Beeminder
- Bitbucket
- Bitly
- Bitwarden
- Box
- Brandfetch
- Brevo
- Bubble
- Cal.com
- Calendly
- Chargebee
- CircleCI
- Cisco
- Clearbit
- ClickUp
- Clockify
- Cloudflare
- Cockpit
- Coda
- CoinGecko
- Contentful
- ConvertKit
- Copper
- Cortex
- CrateDB
- Currents
- Customer.io
- Databricks
- DeepL
- Demio
- Dhl
- Discord
- Discourse
- Disqus
- Drift
- Dropbox
- Dropcontact
- Egoi
- Elastic
- Emelia
- ERPNext
- Eventbrite
- Facebook
- Facebook Lead Ads
- Figma
- FileMaker
- Flow
- Form.io
- Formstack
- Freshdesk
- Freshservice
- Freshworks CRM
- FTP
- GetResponse
- Ghost
- Git
- GitHub
- GitLab
- Gong
- Google
- Gotify
- GoTo Webinar
- Grafana
- Grist
- Gumroad
- Hacker News
- HaloPSA
- Harvest
- Help Scout
- HighLevel
- Home Assistant
- HubSpot
- Humantic AI
- Hunter
- Intercom
- Invoice Ninja
- Iterable
- Jenkins
- Jina AI
- Jira
- JotForm
- Kafka
- Keap
- KoBoToolbox
- LDAP
- Lemlist
- Line
- Linear
- LingvaNex
- LinkedIn
- LoneScale
- Magento
- Mailcheck
- Mailchimp
- MailerLite
- Mailgun
- Mailjet
- Mandrill
- Marketstack
- Matrix
- Mattermost
- Mautic
- Medium
- MessageBird
- Metabase
- Microsoft
- Mindee
- Misp
- Mistral AI
- Mocean
- monday.com
- MongoDB
- Monica CRM
- MQTT
- MSG91
- MySQL
- Nasa
- Netlify
- Netscaler
- Nextcloud
- NocoDB
- Notion
- Npm
- Odoo
- Okta
- One Simple API
- Onfleet
- OpenAI
- OpenThesaurus
- OpenWeatherMap
- Oracle
- Orbit
- Oura
- Paddle
- PagerDuty
- PayPal
- Peekalink
- Perplexity
- Phantombuster
- PhilipsHue
- Pipedrive
- Plivo
- PostBin
- Postgres
- PostHog
- Postmark
- ProfitWell
- Pushbullet
- Pushcut
- Pushover
- QuestDB
- QuickBase
- QuickBooks
- QuickChart
- RabbitMQ
- Raindrop
- Reddit
- Redis
- Rocket.Chat
- Rundeck
- S3
- Salesforce
- Salesmate
- SeaTable
- SecurityScorecard
- Segment
- SendGrid
- Sendy
- Sentry.io
- ServiceNow
- Shopify
- SIGNL4
- Slack
- Sms77
- Snowflake
- Splunk
- Spotify
- Stackby
- Storyblok
- Strapi
- Strava
- Stripe
- Supabase
- SurveyMonkey
- SyncroMSP
- Taiga
- Tapfiliate
- Telegram
- TheHive
- TheHive 5
- TimescaleDB
- Todoist
- Toggl
- Travis CI
- Trello
- Twake
- Twilio
- Twist
- Twitter
- Typeform
- Unleashed Software
- UpLead
- uProc
- UptimeRobot
- urlscan.io
- Venafi
- Vero
- Vonage
- Webflow
- Wekan
- WhatsApp Business
- Wise
- WooCommerce
- WordPress
- Workable
- WorkflowTrigger
- Wufoo
- Xero
- YOURLS
- Zammad
- Zendesk
- Zoho CRM
- Zoom
- Zulip

---

## AI / LLM model vendors (8)

Exposed through the LangChain-based AI nodes (chat models, embeddings, etc.):

- AlibabaCloud
- Anthropic
- GoogleGemini
- Microsoft
- MiniMax
- Moonshot
- Ollama
- OpenAI

> Plus AI building-block node categories: Agents, Chains, Document Loaders, Embeddings, LLMs, Memory, Output Parsers, Rerankers, Retrievers, Text Splitters, Tools, Vector Stores, MCP, Guardrails, Model Selector, Tool Executor.

---

## AWS — bundled sub-services (12)

(The `AWS` integration above expands to these individual service nodes.)

- AWS CertificateManager
- AWS Cognito
- AWS Comprehend
- AWS DynamoDB
- AWS ELB
- AWS IAM
- AWS Rekognition
- AWS S3
- AWS SES
- AWS SQS
- AWS Textract
- AWS Transcribe

---

## Google — bundled sub-services (21)

(The `Google` integration above expands to these.)

- Google Ads
- Google Analytics
- Google BigQuery
- Google Books
- Google BusinessProfile
- Google Calendar
- Google Chat
- Google CloudNaturalLanguage
- Google CloudStorage
- Google Contacts
- Google Docs
- Google Drive
- Google Firebase
- Google GSuiteAdmin
- Google Gmail
- Google Perspective
- Google Sheet
- Google Slides
- Google Task
- Google Translate
- Google YouTube

---

## Microsoft — bundled sub-services (12)

(The `Microsoft` integration above expands to these.)

- Microsoft AzureCosmosDb
- Microsoft Dynamics
- Microsoft Entra
- Microsoft Excel
- Microsoft GraphSecurity
- Microsoft OneDrive
- Microsoft Outlook
- Microsoft SharePoint
- Microsoft Sql
- Microsoft Storage
- Microsoft Teams
- Microsoft ToDo

---

## Core / flow-control / utility nodes (67)

Not third-party integrations — these are n8n's built-in primitives (control flow, data transforms, generic protocols, triggers):

- AiTransform
- Code
- CompareDatasets
- Compression
- Cron
- Crypto
- DataTable
- DateTime
- DebugHelper
- DynamicCredentialCheck
- E2eTest
- EditImage
- EmailReadImap
- EmailSend
- ErrorTrigger
- Evaluation
- ExecuteCommand
- ExecuteWorkflow
- ExecutionData
- Files
- Filter
- Form
- Function
- FunctionItem
- GraphQL
- Html
- HtmlExtract
- HttpRequest
- ICalendar
- If
- Interval
- ItemLists
- Jwt
- LocalFileTrigger
- ManualTrigger
- Markdown
- Merge
- MessageAnAgent
- MoveBinaryData
- N8n
- N8nTrainingCustomerDatastore
- N8nTrainingCustomerMessenger
- N8nTrigger
- NoOp
- ReadBinaryFile
- ReadBinaryFiles
- ReadPdf
- RenameKeys
- RespondToWebhook
- RssFeedRead
- Schedule
- Set
- Simulate
- SplitInBatches
- SpreadsheetFile
- SseTrigger
- Ssh
- StickyNote
- StopAndError
- Switch
- TimeSaved
- Totp
- Transform
- Wait
- Webhook
- WriteBinaryFile
- Xml
