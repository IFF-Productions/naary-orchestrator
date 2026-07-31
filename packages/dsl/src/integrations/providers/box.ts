// ── Box (cloud, api.box.com/2.0; auth = an access token as a Bearer. `get_me` is the
//    credential probe) ─────────────────────────────────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const BOX: IntegrationProvider = {
  key: "box",
  label: "Box",
  baseUrl: "https://api.box.com/2.0",
  authScheme: "bearer",
  description: "Work with Box files and folders — list, get, create, delete.",
  auth: "A custom connection whose token is a Box access token — sent as a Bearer token.",
  actions: [
    {
      key: "list_folder_items",
      label: "List folder items",
      description: "List the items (files and folders) in a folder.",
      method: "GET",
      pathTemplate: "/folders/{folderId}/items",
      write: false,
      fields: [
        {
          key: "folderId",
          label: "Folder id",
          in: "path",
          required: true,
          hint: "the root folder id is '0'",
        },
        {
          key: "limit",
          label: "Limit",
          in: "query",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "get_file",
      label: "Get file",
      description: "Fetch a file's information by id.",
      method: "GET",
      pathTemplate: "/files/{fileId}",
      write: false,
      fields: [{ key: "fileId", label: "File id", in: "path", required: true }],
    },
    {
      key: "create_folder",
      label: "Create folder",
      description: "Create a new folder under a parent folder.",
      method: "POST",
      pathTemplate: "/folders",
      write: true,
      fields: [
        { key: "name", label: "Name", in: "body", required: true },
        {
          key: "parent",
          label: "Parent (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: '{ "id": "0" } for root',
        },
      ],
    },
    {
      key: "delete_file",
      label: "Delete file",
      description: "Delete a file by id.",
      method: "DELETE",
      pathTemplate: "/files/{fileId}",
      write: true,
      fields: [{ key: "fileId", label: "File id", in: "path", required: true }],
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
