import type { GraphDef } from "./types";

/**
 * Product-facing starter templates, wave 2 (#574) — split out of templates.ts, which crossed
 * the 1000-line maintainability gate. Same contract as its sibling: every graph here MUST
 * pass BOTH save gates (validateGraph + validateGraphConfigs) and every model id MUST exist
 * in @naary/usage's MODEL_PRICING, both enforced by apps/api/test/templates.controller.spec.ts.
 *
 * Where wave 1 covers the everyday shapes (digest, report, triage), these cover what actually
 * differentiates the product: multi-agent handoff (#580), RAG, code agents that open pull
 * requests, MCP publication, budget-capped agents, and durable SLA escalation.
 *
 * Config values that reference tenant resources (a `connectionId`, an email `to`, a `repo`)
 * are placeholders the user edits after installing.
 */

/* ------------------------------------------------------------------ #574 wave 2
 * The templates below exercise what actually differentiates this orchestrator —
 * durable human-in-the-loop, budget-capped agents, RAG, code agents that open PRs,
 * MCP tools, and multi-agent handoff (#580). Every one is round-tripped through BOTH
 * save gates (validateGraph + validateGraphConfigs) by templates.controller.spec.ts, and
 * every model id is asserted to exist in the pricing table — a template that saves but
 * then dies on the ledger write would be worse than no template at all.
 * ---------------------------------------------------------------------------- */

/**
 * Multi-agent supervisor → specialist handoff (#580 Phase 1). A support request arrives on
 * a webhook; the supervisor agent picks exactly ONE specialist and hands it a typed
 * payload; that specialist answers; the answer is returned synchronously.
 *
 * How the routing works, and why it needs no new engine primitive: `handoff.targets` makes
 * the agent's structured output an ENUM of the target names (so the model cannot invent a
 * route), and each outgoing edge is a plain `eq` condition on the chosen name — the same
 * conditional-edge evaluation every other branch in the DSL uses. The choice is made
 * inside the agent ACTIVITY, so the interpreter stays deterministic.
 *
 * Each specialist is an ordinary agent node, so each gets its own ledger row (keyed by
 * `nodeId`) — per-agent cost attribution comes for free, unlike a free-running crew
 * framework where the whole crew is one opaque bill.
 *
 * The reply coalesces the three specialist branches with embedded `{{ }}` tokens: only the
 * branch that actually ran resolves, and an unresolved embedded token renders as an empty
 * string, so exactly one answer lands in the body. Needs no connection — it runs on your
 * model key alone.
 */
export const supervisorHandoffGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "supervisor",
      name: "Supervisor",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "You are the front desk for a software company's support queue. Read the inbound request and route it to the one specialist best equipped to answer it. Do not answer it yourself.",
        handoff: {
          targets: [
            {
              to: "billing",
              name: "billing_specialist",
              description:
                "Invoices, plans, refunds, payment failures, seat counts — anything about money.",
            },
            {
              to: "technical",
              name: "technical_specialist",
              description:
                "Errors, outages, API problems, integration and configuration questions.",
            },
            {
              to: "general",
              name: "general_specialist",
              description:
                "Everything else: how-to questions, feedback, and anything that fits no other specialist.",
            },
          ],
          payloadSchema: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description:
                  "The customer's request, restated in one clear sentence.",
              },
              customerTier: {
                type: "string",
                enum: ["free", "pro", "enterprise", "unknown"],
              },
              facts: {
                type: "array",
                items: { type: "string" },
                description:
                  "Concrete details from the request the specialist will need.",
              },
            },
            required: ["question"],
          },
        },
      },
    },
    {
      id: "billing",
      name: "Billing specialist",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        systemPrompt:
          "You are a billing specialist. Answer the brief below precisely and warmly. Never invent an amount, a date, or a policy — if the brief lacks a fact you need, say exactly what you need from the customer.\n\nBrief: {{ supervisor.output.payload }}",
      },
    },
    {
      id: "technical",
      name: "Technical specialist",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        systemPrompt:
          "You are a technical support specialist. Answer the brief below with concrete steps the customer can follow. If you need a log line, request id, or version to be sure, ask for it rather than guessing.\n\nBrief: {{ supervisor.output.payload }}",
      },
    },
    {
      id: "general",
      name: "General specialist",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        systemPrompt:
          "You are a generalist support agent. Answer the brief below briefly and kindly, and say plainly when something is outside what you can help with.\n\nBrief: {{ supervisor.output.payload }}",
      },
    },
    {
      id: "reply",
      type: "respondToWebhook",
      config: {
        statusCode: 200,
        body: {
          handledBy: "{{ supervisor.output.target }}",
          why: "{{ supervisor.output.reason }}",
          // Coalesce: exactly one of the three branches ran, so exactly one token resolves.
          reply:
            "{{ billing.output.text }}{{ technical.output.text }}{{ general.output.text }}",
        },
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "supervisor" },
    // The three handoff edges — the canonical shape `handoffEdges()` builds and
    // `validateHandoffs` enforces: one `eq` per target on the supervisor's chosen name.
    {
      from: "supervisor",
      to: "billing",
      condition: {
        path: "supervisor.output.target",
        op: "eq",
        value: "billing_specialist",
      },
    },
    {
      from: "supervisor",
      to: "technical",
      condition: {
        path: "supervisor.output.target",
        op: "eq",
        value: "technical_specialist",
      },
    },
    {
      from: "supervisor",
      to: "general",
      condition: {
        path: "supervisor.output.target",
        op: "eq",
        value: "general_specialist",
      },
    },
    // Whichever specialist ran continues to the shared reply. NOT a `merge` node on
    // purpose: a merge waits for every inbound branch, and a handoff only ever produces
    // one — the join would never complete.
    { from: "billing", to: "reply" },
    { from: "technical", to: "reply" },
    { from: "general", to: "reply" },
    { from: "reply", to: "end" },
  ],
};

/**
 * Grounded answers over your own documents (RAG). A hosted chat message is embedded and
 * matched against a pgvector collection, and the agent answers using ONLY the retrieved
 * chunks — the standard fix for a chatbot that confidently invents policy. Pair it with
 * the ingest template below to fill the collection.
 */
export const ragAnswerGraph: GraphDef = {
  startNodeId: "chat",
  nodes: [
    {
      id: "chat",
      type: "chatTrigger",
      config: {
        title: "Ask the docs",
        description:
          "Answers come from your indexed documents, quoting the source.",
        placeholder: "What would you like to know?",
        greeting: "Ask me anything about the product docs.",
      },
    },
    {
      id: "retrieve",
      name: "Retrieve chunks",
      type: "vectorQuery",
      config: { collection: "docs", from: "chat", path: "message", topK: 5 },
    },
    {
      id: "answer",
      name: "Grounded answer",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "Answer the question using ONLY the retrieved chunks provided. Quote the wording that supports each claim. If the chunks do not contain the answer, say so plainly and do not fill the gap from general knowledge.\n\nQuestion: {{ chat.message }}\nRetrieved chunks: {{ retrieve.output.matches }}",
      },
    },
    {
      id: "reply",
      type: "respondToWebhook",
      config: { statusCode: 200, body: { text: "{{ answer.output.text }}" } },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "chat", to: "retrieve" },
    { from: "retrieve", to: "answer" },
    { from: "answer", to: "reply" },
    { from: "reply", to: "end" },
  ],
};

/**
 * Keep a RAG collection fresh. On a schedule, pull a feed (a changelog, a docs RSS, a
 * status feed), embed each entry, and upsert it into the same collection the answer
 * template queries. Swap `rssRead` for an httpRequest or sqlQuery to index any source.
 */
export const ragIngestGraph: GraphDef = {
  startNodeId: "schedule",
  nodes: [
    { id: "schedule", type: "scheduleTrigger", config: { cron: "0 3 * * *" } },
    {
      id: "source",
      type: "rssRead",
      config: { url: "https://hnrss.org/frontpage" },
    },
    {
      id: "index",
      name: "Embed & index",
      type: "vectorUpsert",
      config: { collection: "docs", from: "source", path: "items" },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "schedule", to: "source" },
    { from: "source", to: "index" },
    { from: "index", to: "end" },
  ],
};

/**
 * Issue → reviewed plan → pull request. A GitHub issue opens; an agent decides whether it
 * is small and well-specified enough to attempt automatically and writes the plan; a HUMAN
 * approves that plan (the run parks durably here — for days if need be); only then does
 * the code agent clone the repo in its sandbox, make the change, and open a PR; finally
 * the result is posted back on the issue.
 *
 * The code agent is BUDGET-CAPPED (`maxBudgetUsd`) and turn-capped (`maxTurns`) — a
 * runaway coding loop stops costing money instead of quietly burning the month's budget.
 * Set `repo` and point the connection at your GitHub App install before running.
 */
export const codeAgentPrGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "plan",
      name: "Judge & plan the fix",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "A GitHub issue was just opened. Decide whether it is small, well-specified, and low-risk enough for an automated fix, then write the plan a coding agent should follow. Be conservative: anything touching auth, billing, migrations, or public API shape is not a candidate.",
        outputSchema: {
          type: "object",
          properties: {
            attempt: {
              type: "boolean",
              description: "Whether an automated fix should be attempted.",
            },
            rationale: { type: "string" },
            plan: {
              type: "string",
              description: "Step-by-step instructions for the coding agent.",
            },
          },
          required: ["attempt", "rationale", "plan"],
        },
      },
    },
    {
      id: "approval",
      type: "humanApproval",
      config: {
        title: "Approve the automated fix",
        instructions:
          "The agent proposes attempting this issue automatically. Read the plan. Approve to let the code agent open a PR (it never pushes to your default branch); reject to leave the issue to a human.",
        timeoutHours: 48,
        slaHours: 8,
      },
    },
    {
      id: "fix",
      name: "Write the fix & open a PR",
      type: "codeAgent",
      config: {
        tool: "claude",
        mode: "write",
        repo: "your-org/your-repo",
        connectionId: "github",
        prompt: "{{ plan.output.plan }}",
        maxTurns: 20,
        maxBudgetUsd: 2,
        openPr: true,
        prTitle: "Automated fix for the linked issue",
        prBody:
          "Opened by a naary code-agent run after human approval.\n\nPlan:\n{{ plan.output.plan }}",
      },
    },
    {
      id: "comment",
      type: "integration",
      config: {
        provider: "github",
        action: "comment_issue",
        connectionId: "github",
        fieldBindings: {
          issueNumber: { from: "trigger", path: "issue.number" },
          body: { from: "fix", path: "output.result" },
        },
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "plan" },
    // Only a plan the agent itself judged worth attempting reaches the human.
    {
      from: "plan",
      to: "approval",
      condition: { path: "plan.output.attempt", op: "eq", value: true },
    },
    // "not a candidate" is a real, successful outcome — route it to `end` explicitly rather
    // than letting the walk run out of live edges. Same result, but the run reads as
    // completed-and-declined on the run detail page instead of stopping mid-graph, and the
    // rationale is in ctx for whoever picks the issue up.
    {
      from: "plan",
      to: "end",
      condition: { path: "plan.output.attempt", op: "neq", value: true },
    },
    { from: "approval", to: "fix" },
    { from: "fix", to: "comment" },
    { from: "comment", to: "end" },
  ],
};

/**
 * A cost-capped research agent that uses real tools. On a schedule, an agent runs a
 * bounded tool loop over an MCP connection, then emails the brief it produced.
 *
 * Every cost lever this node has is set on purpose: the cheapest capable model, a hard
 * `maxOutputTokens` cap, and `maxToolSteps` to bound the reasoning/tool loop (which also
 * bounds Temporal history growth). Combined with the workspace's own monthly budget, an
 * agent left on a nightly schedule cannot quietly become the biggest line on the bill.
 * Point the tool at your MCP connection and rename it to what that server actually offers.
 */
export const budgetCappedResearchGraph: GraphDef = {
  startNodeId: "schedule",
  nodes: [
    {
      id: "schedule",
      type: "scheduleTrigger",
      config: { cron: "0 7 * * 1-5" },
    },
    {
      id: "research",
      name: "Research (capped)",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        systemPrompt:
          "Produce a short morning brief on what changed since yesterday. Use the search tool for anything you are not certain of, at most a handful of times, then stop and write. Prefer saying you could not confirm something over guessing.",
        maxOutputTokens: 800,
        maxToolSteps: 6,
        tools: [
          {
            connectionId: "mcp",
            tool: "search",
            description:
              "Search the connected knowledge source. Call it with a short query string.",
          },
        ],
        outputSchema: {
          type: "object",
          properties: {
            headline: { type: "string" },
            bullets: { type: "array", items: { type: "string" } },
            unconfirmed: {
              type: "array",
              items: { type: "string" },
              description: "Anything the agent could not verify with a tool.",
            },
          },
          required: ["headline", "bullets"],
        },
      },
    },
    {
      id: "email",
      type: "sendEmail",
      config: {
        connectionId: "smtp",
        to: "you@example.com",
        subject: "Morning brief — {{ research.output.headline }}",
        text: "{{ research.output.bullets }}\n\nCould not confirm:\n{{ research.output.unconfirmed }}",
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "schedule", to: "research" },
    { from: "research", to: "email" },
    { from: "email", to: "end" },
  ],
};

/**
 * Publish this workflow AS an MCP tool. Because the entry node is an `mcpServerTrigger`,
 * the workflow shows up as a callable tool on your workspace's MCP endpoint — so Claude
 * (or any MCP client) can invoke it by name, with your prompt, your model key, and your
 * budget, and every call is a durable, auditable run.
 *
 * The inverse of the mcpTool node: that one lets your workflow call someone else's tools;
 * this one turns your workflow INTO a tool.
 */
export const mcpServerToolGraph: GraphDef = {
  startNodeId: "tool",
  nodes: [
    {
      id: "tool",
      type: "mcpServerTrigger",
      config: {
        toolName: "summarize_ticket",
        description:
          "Summarize a support ticket into a one-line title, a short summary, and a suggested priority. Pass { text: string }.",
      },
    },
    {
      id: "summarize",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        systemPrompt:
          "Summarize the support ticket text you are given. Be factual; do not add recommendations the text does not support.",
        outputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            priority: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["title", "summary", "priority"],
        },
      },
    },
    {
      id: "reply",
      type: "respondToWebhook",
      config: {
        statusCode: 200,
        bodyBinding: { from: "summarize", path: "output" },
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "tool", to: "summarize" },
    { from: "summarize", to: "reply" },
    { from: "reply", to: "end" },
  ],
};

/**
 * Turn a form submission into a database row. A hosted public form collects an expense
 * claim, an agent normalizes the free text into typed fields, and a parameterized INSERT
 * writes it — parameters are BOUND from the agent's output, never string-concatenated into
 * the SQL. Point `app-db` at your database and reshape the table to match.
 */
export const formToDbGraph: GraphDef = {
  startNodeId: "form",
  nodes: [
    {
      id: "form",
      type: "formTrigger",
      config: {
        title: "Submit an expense",
        description: "Describe the expense in your own words — we'll file it.",
        submitLabel: "Submit expense",
        fields: [
          {
            key: "description",
            label: "What did you buy, and why?",
            type: "textarea",
            required: true,
          },
          { key: "email", label: "Your email", type: "email", required: true },
        ],
      },
    },
    {
      id: "extract",
      name: "Extract fields",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        systemPrompt:
          "Extract structured expense fields from the submission. Amounts are in the currency the submitter wrote; if a field genuinely is not stated, leave it out rather than inventing it.\n\nSubmission: {{ form.description }}",
        outputSchema: {
          type: "object",
          properties: {
            vendor: { type: "string" },
            amount: { type: "number" },
            currency: { type: "string" },
            category: {
              type: "string",
              enum: ["travel", "software", "hardware", "meals", "other"],
            },
            summary: { type: "string" },
          },
          required: ["amount", "currency", "category", "summary"],
        },
      },
    },
    {
      id: "insert",
      name: "Insert row",
      type: "sqlExec",
      config: {
        connectionId: "app-db",
        sql: "INSERT INTO expenses (vendor, amount, currency, category, summary, submitted_by) VALUES ($1, $2, $3, $4, $5, $6)",
        paramBindings: {
          1: { from: "extract", path: "output.vendor" },
          2: { from: "extract", path: "output.amount" },
          3: { from: "extract", path: "output.currency" },
          4: { from: "extract", path: "output.category" },
          5: { from: "extract", path: "output.summary" },
          6: { from: "form", path: "email" },
        },
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "form", to: "extract" },
    { from: "extract", to: "insert" },
    { from: "insert", to: "end" },
  ],
};

/**
 * Severity-routed escalation with an SLA. An alert arrives; an agent grades it; a
 * high-severity alert opens a Jira ticket AND parks on a human acknowledgement that
 * reminds, then escalates, if nobody responds in time; anything lower is filed by email.
 * This is the flow that shows what "durable" buys you: the wait can last days, survives
 * worker restarts, and chases someone on a schedule while it waits.
 */
export const escalationGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "grade",
      name: "Grade severity",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        systemPrompt:
          "Grade the inbound alert. `severity` is high only when customers are affected right now or data is at risk. Say what you are unsure about instead of rounding up.",
        outputSchema: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["low", "medium", "high"] },
            title: { type: "string" },
            impact: { type: "string" },
            firstStep: { type: "string" },
          },
          required: ["severity", "title", "impact"],
        },
      },
    },
    {
      id: "ticket",
      name: "Open Jira ticket",
      type: "integration",
      config: {
        provider: "jira",
        action: "create_issue",
        connectionId: "jira",
        fieldBindings: {
          summary: { from: "grade", path: "output.title" },
          description: { from: "grade", path: "output.impact" },
        },
      },
    },
    {
      id: "ack",
      type: "humanApproval",
      config: {
        title: "Acknowledge the high-severity alert",
        instructions:
          "Approve once someone owns this incident. If nobody acknowledges in time you will be reminded, then it escalates.",
        timeoutHours: 24,
        slaHours: 1,
        remindAfterHours: [1, 4],
        escalateAfterHours: 6,
      },
    },
    {
      id: "file",
      type: "sendEmail",
      config: {
        connectionId: "smtp",
        to: "oncall@example.com",
        subject: "[{{ grade.output.severity }}] {{ grade.output.title }}",
        text: "{{ grade.output.impact }}\n\nSuggested first step: {{ grade.output.firstStep }}",
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "grade" },
    {
      from: "grade",
      to: "ticket",
      condition: { path: "grade.output.severity", op: "eq", value: "high" },
    },
    {
      from: "grade",
      to: "file",
      condition: { path: "grade.output.severity", op: "neq", value: "high" },
    },
    { from: "ticket", to: "ack" },
    { from: "ack", to: "end" },
    { from: "file", to: "end" },
  ],
};
