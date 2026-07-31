// ── Todoist (cloud, api.todoist.com/api/v1; auth = an API token as a Bearer) ──────────
import type { IntegrationProvider } from "../types";

export const TODOIST: IntegrationProvider = {
  key: "todoist",
  label: "Todoist",
  // Was `https://api.todoist.com/rest/v2`, which Todoist has REMOVED — not deprecated. Measured
  // 2026-07-29: `GET /rest/v2/tasks` → **410 Gone** (with or without a token), `GET /api/v1/tasks`
  // → 401. A 410 is the server saying the resource is permanently gone, so every Todoist action in
  // this catalog failed for every user, and no credential could have made it work. The unified v1
  // API takes the same task paths and the same create-task body keys, so this is a base-URL move;
  // the one casualty is `list_tasks`' `filter`, which v1 serves from a separate endpoint.
  baseUrl: "https://api.todoist.com/api/v1",
  description: "Manage Todoist tasks — list, get, create, and close.",
  auth: "A custom connection whose token is a Todoist API token.",
  actions: [
    {
      key: "list_tasks",
      label: "List tasks",
      description: "List active tasks, optionally filtered by project.",
      method: "GET",
      pathTemplate: "/tasks",
      write: false,
      fields: [
        {
          // Query field KEY is the literal param name (query has no bodyPath remap), so it must be
          // Todoist's snake_case `project_id`, not `projectId` (#647 review).
          key: "project_id",
          label: "Project id",
          in: "query",
          required: false,
          hint: "filter by project",
        },
        // `filter` is GONE with `/rest/v2`: v1 declares only project_id/section_id/parent_id/label/
        // ids/cursor/limit here and serves filter queries from `GET /api/v1/tasks/filter?query=…`,
        // a different operation. Kept out rather than left in place as a parameter the API ignores.
      ],
    },
    {
      key: "get_task",
      label: "Get task",
      description: "Fetch a single task by id.",
      method: "GET",
      pathTemplate: "/tasks/{taskId}",
      write: false,
      fields: [{ key: "taskId", label: "Task id", in: "path", required: true }],
    },
    {
      key: "create_task",
      label: "Create task",
      description: "Create a new task.",
      method: "POST",
      pathTemplate: "/tasks",
      write: true,
      fields: [
        { key: "content", label: "Content", in: "body", required: true },
        {
          key: "description",
          label: "Description",
          in: "body",
          required: false,
        },
        {
          key: "projectId",
          label: "Project id",
          in: "body",
          required: false,
          bodyPath: "project_id",
        },
        {
          key: "dueString",
          label: "Due (natural language)",
          in: "body",
          required: false,
          bodyPath: "due_string",
        },
        {
          key: "priority",
          label: "Priority",
          in: "body",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "close_task",
      label: "Close task",
      description: "Close (complete) a task by id.",
      method: "POST",
      pathTemplate: "/tasks/{taskId}/close",
      write: true,
      fields: [{ key: "taskId", label: "Task id", in: "path", required: true }],
    },
  ],
};
