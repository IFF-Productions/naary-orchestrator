/**
 * CURATED MCP servers (#578) — the in-repo, human-vetted corpus.
 *
 * Two jobs:
 *   1. the `curated` trust tier in the browser UI (vs `community`, which comes from the public
 *      registry and is attacker-authorable);
 *   2. the DEGRADED mode: when the upstream registry is unreachable/slow/garbage, the endpoint
 *      returns this list instead of failing (an explicit AC of #578). That makes discovery work
 *      offline and makes the whole feature testable with no network.
 *
 * Every entry is a REMOTE (Streamable-HTTP) MCP endpoint, because that is the only transport
 * `packages/connections/src/mcp.ts` speaks — a stdio/npx-only server can't become a Connection.
 *
 * HONESTY NOTE: these URLs are the vendors' published remote MCP endpoints as of the date below.
 * They were NOT live-probed from this repo (CI has no credentials and no guaranteed egress), so
 * treat "vetted" as "reviewed and shape-checked", not "connection-tested". Each entry still passes
 * the same `sanitizeTransportUrl` gate as an untrusted registry row (asserted in the tests), so a
 * typo here can't smuggle in an http/private-host URL.
 */
import type { McpRegistryServer } from "./registry-sanitize";

export const CURATED_AS_OF = "2026-07-25";

/** The curated corpus. `trust` is fixed to "curated" — the service never lets upstream data claim it. */
export const CURATED_SERVERS: readonly McpRegistryServer[] = [
  {
    id: "curated:github",
    name: "GitHub",
    description:
      "Issues, pull requests, code search and repository files. Sign in with GitHub to authorize.",
    transportUrl: "https://api.githubcopilot.com/mcp/",
    transport: "http",
    authMode: "oauth",
    requiresAuth: true,
    trust: "curated",
    homepage: "https://github.com/github/github-mcp-server",
    tags: ["code", "issues", "pull-requests"],
  },
  {
    id: "curated:atlassian",
    name: "Atlassian (Jira & Confluence)",
    description:
      "Jira issues and Confluence pages for your Atlassian site. Authorizes over OAuth.",
    transportUrl: "https://mcp.atlassian.com/v1/sse",
    transport: "http",
    authMode: "oauth",
    requiresAuth: true,
    trust: "curated",
    homepage: "https://www.atlassian.com/platform/remote-mcp-server",
    tags: ["issues", "docs", "project-management"],
  },
  {
    id: "curated:linear",
    name: "Linear",
    description:
      "Read and update Linear issues, projects and cycles. Authorizes over OAuth.",
    transportUrl: "https://mcp.linear.app/mcp",
    transport: "http",
    authMode: "oauth",
    requiresAuth: true,
    trust: "curated",
    homepage: "https://linear.app/docs/mcp",
    tags: ["issues", "project-management"],
  },
  {
    id: "curated:notion",
    name: "Notion",
    description:
      "Search, read and write Notion pages and databases. Authorizes over OAuth.",
    transportUrl: "https://mcp.notion.com/mcp",
    transport: "http",
    authMode: "oauth",
    requiresAuth: true,
    trust: "curated",
    homepage: "https://developers.notion.com/docs/mcp",
    tags: ["docs", "knowledge-base"],
  },
  {
    id: "curated:sentry",
    name: "Sentry",
    description:
      "Inspect issues, events and releases from your Sentry organization. Authorizes over OAuth.",
    transportUrl: "https://mcp.sentry.dev/mcp",
    transport: "http",
    authMode: "oauth",
    requiresAuth: true,
    trust: "curated",
    homepage: "https://docs.sentry.io/product/sentry-mcp/",
    tags: ["observability", "errors"],
  },
  {
    id: "curated:stripe",
    name: "Stripe",
    description:
      "Customers, payments, subscriptions and invoices. Paste a restricted Stripe API key.",
    // Trailing slash: the corpus stores already-NORMALIZED URLs (WHATWG `new URL(…).toString()`),
    // which the test asserts — so a curated row is byte-identical to what the sanitizer would emit.
    transportUrl: "https://mcp.stripe.com/",
    transport: "http",
    authMode: "api_token",
    requiresAuth: true,
    trust: "curated",
    homepage: "https://docs.stripe.com/mcp",
    tags: ["payments", "billing"],
  },
  {
    id: "curated:context7",
    name: "Context7 (library docs)",
    description:
      "Up-to-date documentation and code examples for public libraries and frameworks.",
    transportUrl: "https://mcp.context7.com/mcp",
    transport: "http",
    authMode: "api_token",
    requiresAuth: true,
    trust: "curated",
    homepage: "https://context7.com",
    tags: ["docs", "reference"],
  },
  {
    id: "curated:deepwiki",
    name: "DeepWiki",
    description:
      "Ask questions about any public GitHub repository's architecture and code. No credentials needed.",
    transportUrl: "https://mcp.deepwiki.com/mcp",
    transport: "http",
    authMode: "none",
    requiresAuth: false,
    trust: "curated",
    homepage: "https://deepwiki.com",
    tags: ["code", "docs", "no-auth"],
  },
];
