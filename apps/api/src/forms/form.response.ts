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

/** Public form definition served to an anonymous browser — NO tenant/workflow identifiers. */
export class FormDefinitionResponse {
  @ApiProperty({ example: "3f9a1c2e-…" }) formId!: string;
  @ApiProperty({ required: false, example: "Contact us" }) title?: string;
  @ApiProperty({ required: false, example: "We'll get back to you." })
  description?: string;
  @ApiProperty({ required: false, example: "Send" }) submitLabel?: string;
  @ApiProperty({ type: [FormFieldResponse] }) fields!: FormFieldResponse[];
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
