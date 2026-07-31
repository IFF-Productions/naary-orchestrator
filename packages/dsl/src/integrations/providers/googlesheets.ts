// ── Google Sheets (Sheets API v4, sheets.googleapis.com). Auth: an OAuth access token as a
//    Bearer — a Google API KEY is deliberately NOT supported, since an API key travels in a
//    `?key=` query param and the catalog only sends credentials as headers. ──────────────
import type { IntegrationProvider } from "../types";

export const GOOGLESHEETS: IntegrationProvider = {
  key: "googlesheets",
  label: "Google Sheets",
  baseUrl: "https://sheets.googleapis.com",
  authScheme: "bearer",
  description:
    "Read and write a Google Sheet — append rows, read a range, update or clear values.",
  auth: "A connection holding a Google OAuth access token for the `https://www.googleapis.com/auth/spreadsheets` scope, sent as `Authorization: Bearer <token>`. A Google API key will NOT work (API keys go in a `?key=` query param, which this node never sends).",
  unprobeableReason:
    "The Sheets API has no identity endpoint — every call names a spreadsheet. Google's token and " +
    "userinfo endpoints live on a DIFFERENT host, and the check may only call this provider's own " +
    "`baseUrl`, so there is nothing here to call blind. Test a Google Sheets connection with an " +
    "integration node on a canvas (single-node Test), where you can supply a spreadsheet id.",
  actions: [
    {
      key: "get_values",
      label: "Get values",
      description: "Read a range of cells in A1 notation.",
      method: "GET",
      pathTemplate: "/v4/spreadsheets/{spreadsheetId}/values/{range}",
      write: false,
      fields: [
        {
          key: "spreadsheetId",
          label: "Spreadsheet id",
          in: "path",
          required: true,
          hint: "the id in the sheet's URL",
        },
        {
          key: "range",
          label: "Range",
          in: "path",
          required: true,
          hint: "A1 notation, e.g. Sheet1!A1:D20",
        },
        {
          key: "majorDimension",
          label: "Major dimension",
          in: "query",
          required: false,
          hint: "ROWS (default) | COLUMNS",
        },
        {
          key: "valueRenderOption",
          label: "Value render option",
          in: "query",
          required: false,
          hint: "FORMATTED_VALUE | UNFORMATTED_VALUE | FORMULA",
        },
      ],
    },
    {
      key: "append_row",
      label: "Append rows",
      description:
        "Append one or more rows after the last row of a range's table.",
      method: "POST",
      pathTemplate: "/v4/spreadsheets/{spreadsheetId}/values/{range}:append",
      write: true,
      fields: [
        {
          key: "spreadsheetId",
          label: "Spreadsheet id",
          in: "path",
          required: true,
        },
        {
          key: "range",
          label: "Range",
          in: "path",
          required: true,
          hint: "the table to append to, e.g. Sheet1!A1",
        },
        {
          key: "valueInputOption",
          label: "Value input option",
          in: "query",
          required: true,
          hint: "USER_ENTERED (parse like typing) | RAW",
        },
        {
          key: "insertDataOption",
          label: "Insert data option",
          in: "query",
          required: false,
          hint: "INSERT_ROWS | OVERWRITE",
        },
        {
          key: "values",
          label: "Values",
          in: "body",
          required: true,
          type: "json",
          hint: '[["Ada", "ada@acme.com"]] — an array of rows',
        },
      ],
    },
    {
      key: "update_values",
      label: "Update values",
      description: "Overwrite the cells of a range.",
      method: "PUT",
      pathTemplate: "/v4/spreadsheets/{spreadsheetId}/values/{range}",
      write: true,
      fields: [
        {
          key: "spreadsheetId",
          label: "Spreadsheet id",
          in: "path",
          required: true,
        },
        {
          key: "range",
          label: "Range",
          in: "path",
          required: true,
          hint: "A1 notation, e.g. Sheet1!A2:B2",
        },
        {
          key: "valueInputOption",
          label: "Value input option",
          in: "query",
          required: true,
          hint: "USER_ENTERED | RAW",
        },
        {
          key: "values",
          label: "Values",
          in: "body",
          required: true,
          type: "json",
          hint: '[["done", 42]] — rows matching the range',
        },
      ],
    },
    {
      key: "clear_values",
      label: "Clear values",
      description: "Clear the values of a range (formatting is kept).",
      method: "POST",
      pathTemplate: "/v4/spreadsheets/{spreadsheetId}/values/{range}:clear",
      write: true,
      fields: [
        {
          key: "spreadsheetId",
          label: "Spreadsheet id",
          in: "path",
          required: true,
        },
        { key: "range", label: "Range", in: "path", required: true },
      ],
    },
    {
      key: "get_spreadsheet",
      label: "Get spreadsheet",
      description:
        "Fetch the spreadsheet's metadata (its sheets, titles, ids).",
      method: "GET",
      pathTemplate: "/v4/spreadsheets/{spreadsheetId}",
      write: false,
      fields: [
        {
          key: "spreadsheetId",
          label: "Spreadsheet id",
          in: "path",
          required: true,
        },
        {
          key: "includeGridData",
          label: "Include grid data",
          in: "query",
          required: false,
          type: "boolean",
        },
      ],
    },
  ],
};
