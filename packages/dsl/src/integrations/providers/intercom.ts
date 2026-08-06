// ── Intercom (cloud, api.intercom.io, pinned to API version 2.11 via a static header;
//    auth = an access token as a Bearer. `get_me` is the credential probe) ─────────────
//
// ## 2.11 is DELIBERATE, not stale — do not bump it without redoing this (#1126)
//
// Intercom is on 2.16. The pin stays at 2.11 because a version bump changes RESPONSE shapes, and
// under #945 §4 that fails silently: node output is `{status, ok, body}`, authors bind into
// `body.…` in saved workflows, and a renamed or re-typed field evaluates to `undefined` and flows
// downstream rather than erroring. Safe iff the shape is identical.
//
// Intercom publishes one document per version (`intercom/Intercom-OpenAPI`,
// `descriptions/<version>/api.intercom.io.yaml`), so this was compared for real — 2.11 against
// EACH of 2.12…2.16, for these five operations, on name+type. Every candidate differs, on two
// independent blockers at two points on the ladder:
//
//   - `contact.owner_id`: `integer` (example 123) → `string` (example "321") in 2.16 — Intercom's
//     own changelog calls it a breaking change ("now returns as a string type, aligning with
//     Admin.id") on GET/POST contacts, i.e. `get_contact` AND `create_contact`. Worse than an
//     `undefined`: an `if` node comparing it numerically flips its branch in silence.
//   - `admin.avatar`: `object {image_url}` → `string(uri)` from 2.12 ONWARD, which is what closes
//     off 2.12–2.15 too. That is `create_note`'s `body.author.avatar`; a saved
//     `…author.avatar.image_url` goes undefined. Spec-only evidence (description rewritten,
//     `format: uri` added — a re-model, not a tidy-up), no changelog entry names it.
//
// Identical the whole way, 2.11 → 2.16: `send_message` and `get_me`. But the header is
// provider-wide, so two safe actions out of five do not buy a bump.
//
// 2.11 is still ACCEPTED — the current (2.16) document's `intercom_version` enum lists it. That is
// documentation of acceptance, not live verification and not a support commitment: Intercom
// publishes no sunset window anywhere (checked: the versioning docs, the versioning blog post, the
// 2.16 changelog). Nor is a pin a full freeze — their "Unversioned Changes" page ships behaviour
// changes across ALL versions, so this pin fixes the shape contract, not the behaviour.
//
// Field-by-field write-up: issue #1126. `SOURCES.intercom` in extract-openapi-fixtures.mjs records
// why the guard reads 2.16 while we send 2.11, and why that URL has to be hand-bumped.
import type { IntegrationProvider } from "../types";

export const INTERCOM: IntegrationProvider = {
  key: "intercom",
  label: "Intercom",
  baseUrl: "https://api.intercom.io",
  authScheme: "bearer",
  headers: { "Intercom-Version": "2.11" },
  description:
    "Work with Intercom — read/create contacts, add a note, send a message.",
  auth: "A custom connection whose token is an Intercom access token.",
  actions: [
    {
      key: "get_contact",
      label: "Get contact",
      description: "Fetch a single contact by id.",
      method: "GET",
      pathTemplate: "/contacts/{contactId}",
      write: false,
      fields: [
        { key: "contactId", label: "Contact id", in: "path", required: true },
      ],
    },
    {
      key: "create_contact",
      label: "Create contact",
      description: "Create a new contact (user or lead).",
      method: "POST",
      pathTemplate: "/contacts",
      write: true,
      fields: [
        {
          key: "role",
          label: "Role",
          in: "body",
          required: true,
          hint: "user|lead",
        },
        { key: "email", label: "Email", in: "body", required: false },
        { key: "name", label: "Name", in: "body", required: false },
      ],
    },
    {
      key: "create_note",
      label: "Create note",
      description: "Add a note to a contact.",
      method: "POST",
      pathTemplate: "/contacts/{contactId}/notes",
      write: true,
      fields: [
        { key: "contactId", label: "Contact id", in: "path", required: true },
        { key: "body", label: "Note", in: "body", required: true },
      ],
    },
    {
      key: "send_message",
      label: "Send message",
      description: "Send an in-app or email message.",
      method: "POST",
      pathTemplate: "/messages",
      write: true,
      fields: [
        {
          key: "messageType",
          label: "Message type",
          in: "body",
          required: true,
          bodyPath: "message_type",
          hint: "inapp|email",
        },
        { key: "subject", label: "Subject", in: "body", required: false },
        {
          key: "bodyText",
          label: "Body",
          in: "body",
          required: true,
          bodyPath: "body",
        },
        {
          key: "from",
          label: "From",
          in: "body",
          required: true,
          type: "json",
          hint: "{ type, id }",
        },
        {
          key: "to",
          label: "To",
          in: "body",
          required: true,
          type: "json",
          hint: "{ type, id }",
        },
      ],
    },
    {
      key: "get_me",
      label: "Get current admin",
      description:
        "Return the admin this access token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/me",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
