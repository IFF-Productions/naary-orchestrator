# Security Policy

Naary is a durable, multi-tenant orchestrator for AI-agent and webhook workflows. Because tenants
bring their own provider keys and connect their own systems, the security of tenant credentials and
the isolation between tenants is a first-class design goal, not an afterthought. This document
describes how to report a vulnerability and the security model the platform is built on.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through one of:

- **GitHub Private Vulnerability Reporting** — the "Report a vulnerability" button under the
  repository's **Security** tab (preferred).
- **Email** — `security@naary.com` *(update to your organization's security contact)*.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof-of-concept if possible),
- affected component/version or commit, and
- any suggested remediation.

**What to expect:**

- Acknowledgement of your report within **3 business days**.
- An initial assessment (severity + whether we can reproduce) within **10 business days**.
- Coordinated disclosure: we will agree on a disclosure timeline with you and credit you (if you
  wish) once a fix ships.

Please act in good faith: give us reasonable time to remediate before public disclosure, only test
against your own tenant/data, and do not run denial-of-service, spam, or data-exfiltration tests
against shared infrastructure.

## Supported versions

This project is under active development and ships from `main`. Security fixes land on `main` and in
the latest tagged release. Older tagged releases are not separately patched — upgrade to the latest
release to receive security fixes.

## Security model

The architecture enforces a small set of hard invariants. These are treated as non-negotiable and
are checked on every change that touches credentials, execution, or usage.

### Tenant secrets never enter the execution engine

- Provider API keys, connection tokens, and Environment Secrets (`$secrets`) **never** appear in
  Temporal workflow arguments, history, or telemetry. Only a non-secret `tenantId` (and other
  non-secret identifiers such as `environmentId`) flows through workflow state.
- Secrets are fetched and decrypted **inside activities**, by `tenantId`/`environmentId`, used in
  memory, and never returned to workflow code, logged, or placed in telemetry spans.
- `{{ $secrets.NAME }}` references are left **literal** in deterministic workflow code and resolved
  in-memory inside the activity immediately before use.

### Encryption of credentials at rest

- Tenant credentials use **envelope encryption**: a per-tenant Data Encryption Key (DEK) is wrapped
  by a master Key Encryption Key, and values are sealed with **AES-256-GCM** with additional
  authenticated data binding the ciphertext to its `(tenant, provider)` slot.
- The master `ENCRYPTION_KEY` is **required at boot** and is never logged. Key rotation is supported
  (rewrapping DEKs) without re-encrypting every row.
- The usage/billing ledger records **tokens and cost only** — never prompt or completion text.

### Tenant isolation & access control

- Every control-plane request is scoped to a tenant (workspace) and, where applicable, an
  environment (`X-Environment-Id`); reads and writes are filtered by that scope server-side.
- Per-workspace **permission groups** (RBAC) gate view/run/edit/delete/share on workflows and their
  runs; API tokens can be restricted the same way.
- Environment scoping keeps sandbox and production credentials, variables, secrets, and templates as
  separate records.

### Egress & SSRF protection

- Outbound requests made on a tenant's behalf — HTTP, GraphQL, SMTP, RSS, webhook callbacks — pass a
  host-safety check that blocks private/link-local/loopback address ranges, mitigating
  server-side request forgery. Integration and agent egress is scrubbed of secret-shaped values
  before any telemetry leaves the process.

### Provider credential validation

- Provider keys are validated when saved. At run time, provider `401`/`429` (bad or exhausted key)
  are mapped to **non-retryable** failures surfaced to the user, rather than burning retries on a
  credential the user must fix.

### Template & content rendering (XSS)

- Email/form templates are authored as structured blocks. When rendered, interpolated context
  values (which may contain externally-controlled data such as webhook payloads or model output)
  are **context-aware escaped** for the position they land in (HTML text vs. attribute), and URL
  positions reject dangerous schemes (`javascript:`, `data:`, `vbscript:`) after normalizing
  control-character obfuscation.
- Author-supplied rich-text HTML is passed through an **allowlist sanitizer** at the render
  boundary (script/style/iframe and all event-handler attributes removed), so a stored template
  cannot inject script into an email, the in-app preview, or a hosted form.

### Telemetry & privacy

- Error/observability tooling (when enabled) runs a secret scrubber on every outgoing event, log,
  and breadcrumb; session replay is captured in masked mode (text and inputs masked). Prompts,
  completions, and secret values are never sent to telemetry.

## Secrets in configuration

Operators must supply `ENCRYPTION_KEY` and any provider/integration secrets via the deployment
environment (never committed to the repository). Do not paste secrets into issues, pull requests,
or logs.

## Scope

This policy covers the code in this repository. Vulnerabilities in third-party dependencies should be
reported to the respective upstream project; if a dependency issue affects this project, a report
here is still welcome so we can pin or patch.
