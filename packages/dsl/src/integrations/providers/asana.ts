// ── Asana (cloud, app.asana.com/api/1.0; auth = a personal access token as a Bearer.
//    `get_me` is the credential probe) ─────────────────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const ASANA: IntegrationProvider = {
  key: "asana",
  label: "Asana",
  baseUrl: "https://app.asana.com/api/1.0",
  description: "Manage Asana tasks — read, create, update, and comment.",
  auth: "A custom connection whose token is an Asana personal access token.",
  actions: [
    {
      key: "get_task",
      label: "Get task",
      description: "Fetch a single task by gid.",
      method: "GET",
      pathTemplate: "/tasks/{taskGid}",
      write: false,
      fields: [
        { key: "taskGid", label: "Task gid", in: "path", required: true },
      ],
    },
    {
      key: "create_task",
      label: "Create task",
      description: "Create a new task.",
      method: "POST",
      pathTemplate: "/tasks",
      write: true,
      fields: [
        {
          key: "name",
          label: "Name",
          in: "body",
          required: true,
          bodyPath: "data.name",
        },
        {
          key: "notes",
          label: "Notes",
          in: "body",
          required: false,
          bodyPath: "data.notes",
        },
        {
          key: "projects",
          label: "Projects",
          in: "body",
          required: false,
          type: "string[]",
          bodyPath: "data.projects",
          hint: "array of project gids",
        },
      ],
    },
    {
      key: "add_comment",
      label: "Add comment",
      description: "Add a comment (story) to a task.",
      method: "POST",
      pathTemplate: "/tasks/{taskGid}/stories",
      write: true,
      fields: [
        { key: "taskGid", label: "Task gid", in: "path", required: true },
        {
          key: "text",
          label: "Comment",
          in: "body",
          required: true,
          bodyPath: "data.text",
        },
      ],
    },
    {
      key: "update_task",
      label: "Update task",
      description: "Update a task's fields (e.g. mark complete or rename).",
      method: "PUT",
      pathTemplate: "/tasks/{taskGid}",
      write: true,
      fields: [
        { key: "taskGid", label: "Task gid", in: "path", required: true },
        {
          key: "completed",
          label: "Completed",
          in: "body",
          required: false,
          type: "boolean",
          bodyPath: "data.completed",
        },
        {
          key: "name",
          label: "Name",
          in: "body",
          required: false,
          bodyPath: "data.name",
        },
      ],
    },
    {
      key: "get_me",
      label: "Get current user",
      description:
        "Return the user this token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/users/me",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
