// ── Front (cloud, api2.frontapp.com; auth = a Front API token as a Bearer) ────────────
import type { IntegrationProvider } from "../types";

export const FRONT: IntegrationProvider = {
  key: "front",
  label: "Front",
  baseUrl: "https://api2.frontapp.com",
  authScheme: "bearer",
  description:
    "Work with Front conversations — list/get conversations, comment, list inboxes.",
  auth: "A custom connection whose token is a Front API token — sent as a Bearer token.",
  actions: [
    {
      key: "list_conversations",
      label: "List conversations",
      description: "List conversations, optionally filtered by a search query.",
      method: "GET",
      pathTemplate: "/conversations",
      write: false,
      fields: [
        {
          key: "q",
          label: "Query",
          in: "query",
          required: false,
          hint: "search query",
        },
      ],
    },
    {
      key: "get_conversation",
      label: "Get conversation",
      description: "Fetch a single conversation by id.",
      method: "GET",
      pathTemplate: "/conversations/{conversationId}",
      write: false,
      fields: [
        {
          key: "conversationId",
          label: "Conversation id",
          in: "path",
          required: true,
        },
      ],
    },
    {
      key: "add_comment",
      label: "Add comment",
      description: "Add an internal comment to a conversation.",
      method: "POST",
      pathTemplate: "/conversations/{conversationId}/comments",
      write: true,
      fields: [
        {
          key: "conversationId",
          label: "Conversation id",
          in: "path",
          required: true,
        },
        { key: "body", label: "Comment", in: "body", required: true },
        {
          key: "author_id",
          label: "Author id",
          in: "body",
          required: false,
          hint: "teammate id authoring the comment",
        },
      ],
    },
    {
      key: "list_inboxes",
      label: "List inboxes",
      description: "List the inboxes in the account.",
      method: "GET",
      pathTemplate: "/inboxes",
      write: false,
      fields: [],
    },
  ],
};
