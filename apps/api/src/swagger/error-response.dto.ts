import { ApiProperty } from "@nestjs/swagger";

/**
 * The error body every endpoint returns on failure — matches AllExceptionsFilter:
 * `{ statusCode, message }` (message is an array for validation errors), plus Nest's `error`
 * class name on framework exceptions. Never contains internals/secrets (Sec#11).
 */
export class ErrorResponse {
  @ApiProperty({ example: 400, description: "HTTP status code." })
  statusCode!: number;

  @ApiProperty({
    description:
      "Human-readable message — a string, or an array of field errors for validation failures.",
    oneOf: [
      { type: "string", example: "A description is required" },
      { type: "array", items: { type: "string" } },
    ],
  })
  message!: string | string[];

  @ApiProperty({
    required: false,
    example: "Bad Request",
    description: "Error class name (present on framework exceptions).",
  })
  error?: string;
}
