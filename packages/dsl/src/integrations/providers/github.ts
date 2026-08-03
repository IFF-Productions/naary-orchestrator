// ── GitHub (cloud, api.github.com; auth = a PAT or GitHub App token as a Bearer) ──────
import type { IntegrationProvider } from "../types";

export const GITHUB: IntegrationProvider = {
  key: "github",
  label: "GitHub",
  baseUrl: "https://api.github.com",
  headers: {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  },
  description: "Act on GitHub issues — read, create, comment, and label.",
  auth: "A GitHub connection with a Personal Access Token (repo scope) or a GitHub App token, stored as the connection's Bearer token.",
  credentialSetup: {
    tokenUrl: "https://github.com/settings/tokens",
    scopes: ["repo"],
    steps: [
      "Open Settings → Developer settings → Personal access tokens and create a token.",
      "Classic token: tick the repo scope. Fine-grained token: grant Issues: Read and write on the repositories this workflow touches, and add those repositories to the token — the permission alone is not enough.",
      "Copy the token before leaving the page; GitHub shows it once.",
    ],
  },
  actions: [
    {
      key: "get_issue",
      label: "Get issue",
      description: "Fetch a single issue by number.",
      method: "GET",
      pathTemplate: "/repos/{owner}/{repo}/issues/{issueNumber}",
      write: false,
      fields: [
        {
          key: "owner",
          label: "Owner",
          in: "path",
          required: true,
          hint: "org or user, e.g. octocat",
        },
        { key: "repo", label: "Repository", in: "path", required: true },
        {
          key: "issueNumber",
          label: "Issue number",
          in: "path",
          required: true,
          type: "number",
        },
      ],
    },
    {
      key: "get_pull_request",
      label: "Get pull request (as diff)",
      description:
        "Fetch a PR's unified DIFF text (not JSON) — feed it to an agent to review the code changes.",
      method: "GET",
      pathTemplate: "/repos/{owner}/{repo}/pulls/{pullNumber}",
      write: false,
      // The `diff` media type makes GitHub return the raw unified diff as the body
      // (text) instead of the PR's JSON — exactly what a code-review agent needs.
      headers: { Accept: "application/vnd.github.diff" },
      fields: [
        {
          key: "owner",
          label: "Owner",
          in: "path",
          required: true,
          hint: "org or user, e.g. octocat",
        },
        { key: "repo", label: "Repository", in: "path", required: true },
        {
          key: "pullNumber",
          label: "PR number",
          in: "path",
          required: true,
          type: "number",
        },
      ],
    },
    {
      key: "create_issue",
      label: "Create issue",
      description: "Open a new issue in a repository.",
      method: "POST",
      pathTemplate: "/repos/{owner}/{repo}/issues",
      write: true,
      fields: [
        { key: "owner", label: "Owner", in: "path", required: true },
        { key: "repo", label: "Repository", in: "path", required: true },
        { key: "title", label: "Title", in: "body", required: true },
        { key: "body", label: "Body", in: "body", required: false },
        {
          key: "labels",
          label: "Labels",
          in: "body",
          required: false,
          type: "string[]",
        },
      ],
    },
    {
      key: "comment_issue",
      label: "Comment on issue",
      description: "Add a comment to an existing issue.",
      method: "POST",
      pathTemplate: "/repos/{owner}/{repo}/issues/{issueNumber}/comments",
      write: true,
      fields: [
        { key: "owner", label: "Owner", in: "path", required: true },
        { key: "repo", label: "Repository", in: "path", required: true },
        {
          key: "issueNumber",
          label: "Issue number",
          in: "path",
          required: true,
          type: "number",
        },
        { key: "body", label: "Comment", in: "body", required: true },
      ],
    },
    {
      key: "add_labels",
      label: "Add labels",
      description: "Apply labels to an issue.",
      method: "POST",
      pathTemplate: "/repos/{owner}/{repo}/issues/{issueNumber}/labels",
      write: true,
      fields: [
        { key: "owner", label: "Owner", in: "path", required: true },
        { key: "repo", label: "Repository", in: "path", required: true },
        {
          key: "issueNumber",
          label: "Issue number",
          in: "path",
          required: true,
          type: "number",
        },
        {
          key: "labels",
          label: "Labels",
          in: "body",
          required: true,
          type: "string[]",
        },
      ],
    },
    // The two credential probes (#835). GitHub is the provider that forced `probe.authModes` to
    // exist: verified live against api.github.com, a PAT gets 200 from /user and 403 from
    // /installation/repositories, and a GitHub App installation token gets exactly the reverse.
    {
      key: "get_authenticated_user",
      label: "Get authenticated user",
      description:
        "Return the user this token belongs to. Needs no arguments, so it is the connection check for a PAT or OAuth token.",
      method: "GET",
      pathTemplate: "/user",
      write: false,
      probe: true,
      fields: [],
    },
    {
      key: "list_installation_repositories",
      label: "List installation repositories",
      description:
        "List the repositories a GitHub App installation can reach — the connection check for a GitHub App connection, which cannot call /user.",
      method: "GET",
      pathTemplate: "/installation/repositories",
      write: false,
      probe: { authModes: ["github_app"] },
      fields: [],
    },
  ],
};
