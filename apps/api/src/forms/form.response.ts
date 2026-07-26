import { ApiProperty } from "@nestjs/swagger";

/** A freshly registered form endpoint. */
export class RegisteredFormResponse {
  @ApiProperty({ example: "3f9a1c2e-…" }) formId!: string;
  @ApiProperty({
    example: "/forms/3f9a1c2e-…",
    description: "Public path to host the form (host is deployment-specific).",
  })
  formPath!: string;
}

/** Management-list view of a registered form endpoint. */
export class FormEndpointResponse {
  @ApiProperty({ example: "3f9a1c2e-…" }) id!: string;
  @ApiProperty({ example: "contact-form" }) workflowId!: string;
  @ApiProperty({ format: "date-time", example: "2026-07-09T12:00:00.000Z" })
  createdAt!: Date;
}

/** One field of a public form definition. */
export class FormFieldResponse {
  @ApiProperty({ example: "email" }) key!: string;
  @ApiProperty({ example: "Email" }) label!: string;
  @ApiProperty({
    enum: ["text", "textarea", "number", "email", "select"],
    example: "email",
  })
  type!: string;
  @ApiProperty({ required: false, example: true }) required?: boolean;
  @ApiProperty({ required: false, example: "you@example.com" })
  placeholder?: string;
  @ApiProperty({ required: false, type: [String], example: ["Low", "High"] })
  options?: string[];
}

/**
 * Tenant presentation of the hosted page. Every key optional; an absent block renders the stock page.
 *
 * Values are validated at save time (`CONFIG_SCHEMAS.formTrigger`) AND re-validated on read
 * (`projectBranding`) — anything failing either check is DROPPED rather than repaired, so a bad
 * accent falls back to the default and a bad redirect falls back to the success card.
 */
export class FormBrandingResponse {
  @ApiProperty({ required: false, example: "Thanks — we're on it" })
  successTitle?: string;
  @ApiProperty({
    required: false,
    example: "Someone will reach out within one business day.",
    description: "Plain text (rendered as a text node, never HTML).",
  })
  successMessage?: string;
  @ApiProperty({
    required: false,
    example: "https://example.com/thank-you",
    description:
      "Where to send the visitor after a successful submit, instead of the success card. Always " +
      "https with no embedded credentials. Takes precedence over the success copy — except on an " +
      "embedded form, which offers it as a link rather than navigating the host's iframe.",
  })
  redirectUrl?: string;
  @ApiProperty({
    required: false,
    example: "#3355ff",
    description: "Brand accent, exactly `#rrggbb`.",
  })
  accentColor?: string;
  @ApiProperty({ required: false, enum: ["light", "dark", "auto"] })
  theme?: string;
  @ApiProperty({
    required: false,
    enum: [1, 2],
    description:
      "Desktop field columns. Phones always render one; long-answer and choice fields keep a full row.",
  })
  desktopColumns?: number;
  @ApiProperty({ required: false, enum: ["narrow", "wide"] })
  width?: string;
  @ApiProperty({
    required: false,
    example: "9f3a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
    description:
      "An uploaded logo, as an OPAQUE ASSET ID — never a URL. Fetch it from " +
      "`GET /forms/assets/{assetId}` on this origin. Ids are verified to belong to the owning " +
      "workspace environment at save time.",
  })
  logoAssetId?: string;
  @ApiProperty({ required: false, example: "Acme logo" }) logoAlt?: string;
}

/** Public form definition served to an anonymous browser — NO tenant/workflow identifiers. */
export class FormDefinitionResponse {
  @ApiProperty({ example: "3f9a1c2e-…" }) formId!: string;
  @ApiProperty({ required: false, example: "Contact us" }) title?: string;
  @ApiProperty({ required: false, example: "We'll get back to you." })
  description?: string;
  @ApiProperty({ required: false, example: "Send" }) submitLabel?: string;
  @ApiProperty({ type: [FormFieldResponse] }) fields!: FormFieldResponse[];
  @ApiProperty({
    required: false,
    type: "array",
    items: { type: "object", additionalProperties: true },
    description:
      "Present only when a form template drives this form: the template's ordered content blocks, " +
      "so the page can render headings/text/images interleaved with the inputs. `fields` stays " +
      "authoritative for validation — both are derived from the same array.",
  })
  blocks?: unknown[];
  @ApiProperty({ required: false, type: FormBrandingResponse })
  branding?: FormBrandingResponse;
  @ApiProperty({
    required: false,
    example: "0x4AAA…",
    deprecated: true,
    description:
      "DEPRECATED — use `botGate`. Cloudflare Turnstile site key, emitted only for a Turnstile gate. " +
      "Kept for one release because an embedded iframe on a tenant's site may be running a cached " +
      "bundle that only knows this field.",
  })
  turnstileSiteKey?: string;

  @ApiProperty({
    required: false,
    description:
      "The active bot gate, absent when this environment has none. `turnstile` carries the tenant's " +
      "public site key (render the widget, send the solved token back as `botToken`); `app_check` " +
      "carries no key at all — the page mints a Firebase App Check token instead. See " +
      "docs/design/TENANT-BOT-GATE-PROVIDERS.md.",
    oneOf: [
      {
        type: "object",
        required: ["provider", "siteKey"],
        properties: {
          provider: { type: "string", enum: ["turnstile"] },
          siteKey: { type: "string", example: "0x4AAA…" },
        },
      },
      {
        type: "object",
        required: ["provider"],
        properties: { provider: { type: "string", enum: ["app_check"] } },
      },
    ],
  })
  botGate?:
    { provider: "turnstile"; siteKey: string } | { provider: "app_check" };
}

/** How to submit the form the schema describes — the `x-naary-submit` annotation. JSON Schema
 *  ignores unknown keywords, so this rides along inside the schema document itself. */
export class FormSubmitHintResponse {
  @ApiProperty({ example: "POST" }) method!: string;
  @ApiProperty({ example: "/forms/3f9a1c2e-…" }) path!: string;
  @ApiProperty({
    example: false,
    description:
      "True when this environment's Turnstile gate is active. A solved `turnstileToken` is then " +
      "required, and because Turnstile tokens are browser-solved, script submission is not " +
      "supported while it is on.",
  })
  botProtection!: boolean;
  @ApiProperty({ type: [String] }) notes!: string[];
}

/**
 * A JSON Schema (draft 2020-12) for a form's submission body — the contract for POSTing to a form
 * without our hosted page. `properties`/`required` mirror the form's declared fields.
 *
 * The guarantee is one-directional: a payload this schema accepts is a payload the submit route
 * accepts. The reverse does not hold (the route additionally coerces numeric strings and strips
 * unknown keys), so a stricter client is always safe. See src/forms/form-schema.ts.
 */
export class FormJsonSchemaResponse {
  @ApiProperty({ example: "https://json-schema.org/draft/2020-12/schema" })
  $schema!: string;
  @ApiProperty({ required: false, example: "/forms/3f9a1c2e-…/schema" })
  $id?: string;
  @ApiProperty({ example: "Contact us" }) title!: string;
  @ApiProperty({ required: false, example: "We'll get back to you." })
  description?: string;
  @ApiProperty({ example: "object" }) type!: string;
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "One JSON Schema property per declared form field.",
    example: {
      email: { type: "string", format: "email", maxLength: 10000 },
      priority: { type: "string", enum: ["Low", "High"] },
    },
  })
  properties!: Record<string, unknown>;
  @ApiProperty({ required: false, type: [String], example: ["email"] })
  required?: string[];
  @ApiProperty({
    example: true,
    description:
      "Always true: undeclared properties are accepted but discarded, so forbidding them here " +
      "would reject payloads the endpoint takes.",
  })
  additionalProperties!: boolean;
  @ApiProperty({ type: FormSubmitHintResponse, name: "x-naary-submit" })
  "x-naary-submit"!: FormSubmitHintResponse;
}

/** Acknowledgement that a form submission started a run. Deliberately carries NO workflowId —
 *  the internal id embeds the tenantId, and the anonymous submitter has no use for it. */
export class FormSubmitResponse {
  @ApiProperty({ example: "started" }) status!: string;
}

/** Acknowledgement that a form endpoint was deleted. */
export class FormDeletedResponse {
  @ApiProperty({ example: true }) deleted!: boolean;
}

/** A stored hosted-page image. The id is opaque and is the only capability needed to fetch it. */
export class FormAssetResponse {
  @ApiProperty({ example: "9f3a1c2e-…" }) assetId!: string;
  @ApiProperty({
    example: "image/png",
    description:
      "Derived from the file's magic bytes, not from the request's Content-Type header.",
  })
  contentType!: string;
}
