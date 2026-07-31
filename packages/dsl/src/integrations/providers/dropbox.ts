// ── Dropbox (cloud, api.dropboxapi.com/2; auth = an access token as a Bearer).
//    Unprobeable on purpose: its identity call is an RPC POST and the credential check
//    only ever issues a GET ────────────────────────────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const DROPBOX: IntegrationProvider = {
  key: "dropbox",
  label: "Dropbox",
  baseUrl: "https://api.dropboxapi.com/2",
  authScheme: "bearer",
  description:
    "Work with Dropbox files and folders — list, get metadata, create folders, delete.",
  auth: "A custom connection whose token is a Dropbox access token — sent as a Bearer token.",
  unprobeableReason:
    "Dropbox has an argument-free identity call (`/users/get_current_account`) but it is an RPC " +
    "POST, and the credential check only ever issues a GET — a POST probe is one catalog slip away " +
    "from being a write. Test a Dropbox connection with an integration node on a canvas " +
    "(single-node Test).",
  actions: [
    {
      key: "list_folder",
      label: "List folder",
      description: "List the contents of a folder.",
      method: "POST",
      pathTemplate: "/files/list_folder",
      write: false,
      fields: [
        {
          key: "path",
          label: "Path",
          in: "body",
          required: true,
          keepEmpty: true,
          hint: 'folder path, e.g. "" for root or "/Docs"',
        },
      ],
    },
    {
      key: "get_metadata",
      label: "Get metadata",
      description: "Fetch metadata for a file or folder by path.",
      method: "POST",
      pathTemplate: "/files/get_metadata",
      write: false,
      fields: [{ key: "path", label: "Path", in: "body", required: true }],
    },
    {
      key: "create_folder",
      label: "Create folder",
      description: "Create a folder at a path.",
      method: "POST",
      pathTemplate: "/files/create_folder_v2",
      write: true,
      fields: [{ key: "path", label: "Path", in: "body", required: true }],
    },
    {
      key: "delete",
      label: "Delete",
      description: "Delete a file or folder at a path.",
      method: "POST",
      pathTemplate: "/files/delete_v2",
      write: true,
      fields: [{ key: "path", label: "Path", in: "body", required: true }],
    },
  ],
};
