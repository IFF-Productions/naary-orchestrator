// ── ClickUp (cloud, api.clickup.com/api/v2; auth = a personal API token `pk_…` in a bare
//    `Authorization` header — no `Bearer ` prefix (#655). `get_me` is the probe) ────────
import type { IntegrationProvider } from "../types";

export const CLICKUP: IntegrationProvider = {
  key: "clickup",
  label: "ClickUp",
  baseUrl: "https://api.clickup.com/api/v2",
  authScheme: { header: "Authorization" },
  description:
    "Manage ClickUp tasks — create, read, update, list, and comment.",
  auth: "A custom connection whose token is a ClickUp personal API token (`pk_…`), sent as a bare `Authorization` header — no `Bearer ` prefix (#655).",
  actions: [
    {
      key: "create_task",
      label: "Create task",
      description: "Create a new task in a list.",
      method: "POST",
      pathTemplate: "/list/{listId}/task",
      write: true,
      fields: [
        { key: "listId", label: "List id", in: "path", required: true },
        { key: "name", label: "Name", in: "body", required: true },
        {
          key: "description",
          label: "Description",
          in: "body",
          required: false,
        },
        {
          key: "assignees",
          label: "Assignees",
          in: "body",
          required: false,
          type: "string[]",
          hint: "array of assignee user ids",
        },
        {
          key: "priority",
          label: "Priority",
          in: "body",
          required: false,
          type: "number",
          hint: "1 urgent, 2 high, 3 normal, 4 low",
        },
        {
          key: "due_date",
          label: "Due date",
          in: "body",
          required: false,
          type: "number",
          hint: "Unix time in milliseconds",
        },
      ],
    },
    {
      key: "get_task",
      label: "Get task",
      description: "Fetch a single task by id.",
      method: "GET",
      pathTemplate: "/task/{taskId}",
      write: false,
      fields: [{ key: "taskId", label: "Task id", in: "path", required: true }],
    },
    {
      key: "update_task",
      label: "Update task",
      description:
        "Update a task's fields (e.g. rename, set status or priority).",
      method: "PUT",
      pathTemplate: "/task/{taskId}",
      write: true,
      fields: [
        { key: "taskId", label: "Task id", in: "path", required: true },
        { key: "name", label: "Name", in: "body", required: false },
        { key: "status", label: "Status", in: "body", required: false },
        {
          key: "priority",
          label: "Priority",
          in: "body",
          required: false,
          type: "number",
          hint: "1 urgent, 2 high, 3 normal, 4 low",
        },
      ],
    },
    {
      key: "list_tasks",
      label: "List tasks",
      description: "List tasks in a list, with optional paging.",
      method: "GET",
      pathTemplate: "/list/{listId}/task",
      write: false,
      fields: [
        { key: "listId", label: "List id", in: "path", required: true },
        {
          key: "archived",
          label: "Archived",
          in: "query",
          required: false,
          hint: "true|false",
        },
        {
          key: "page",
          label: "Page",
          in: "query",
          required: false,
          type: "number",
          hint: "0-based page number",
        },
      ],
    },
    {
      key: "create_comment",
      label: "Create comment",
      description: "Add a comment to a task.",
      method: "POST",
      pathTemplate: "/task/{taskId}/comment",
      write: true,
      fields: [
        { key: "taskId", label: "Task id", in: "path", required: true },
        {
          key: "comment_text",
          label: "Comment",
          in: "body",
          required: true,
        },
        {
          // ClickUp's own OpenAPI puts `notify_all` in `required` for this operation, and we were
          // not sending it (#813 follow-up). Supplied as a `const` rather than a field, because
          // the flag only decides whether the comment's OWN AUTHOR is also notified — ClickUp's
          // description: "Other assignees and watchers on the task are always notified regardless
          // of this setting." `false` is therefore both the no-op value and the sane default for
          // an automated comment, so this cannot change behaviour where ClickUp treats the key as
          // optional, and fixes the call where it does not.
          key: "notify_all",
          label: "Notify all",
          in: "body",
          required: false,
          type: "boolean",
          const: false,
        },
      ],
    },
    {
      key: "get_me",
      label: "Get authorized user",
      description:
        "Return the user this token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/user",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
