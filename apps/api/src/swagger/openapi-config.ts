import { DocumentBuilder } from "@nestjs/swagger";

/**
 * The single source of the API's OpenAPI document config (title/description/version +
 * the bearer scheme). Shared by the live boot path (main.ts, served at /docs-json) and
 * the standalone spec emitter (emit-openapi.ts, `pnpm gen:openapi`) so the two can never
 * drift on doc metadata — a version bump here reaches both.
 */
export function buildOpenApiConfig(): ReturnType<DocumentBuilder["build"]> {
  return new DocumentBuilder()
    .setTitle("naary API")
    .setDescription(
      "Control plane for durable, human-in-the-loop AI-agent + webhook workflows. " +
        "Authenticate every request with `Authorization: Bearer <token>` — an `nry_` API " +
        "token (mint one in the app, or `POST /tokens`) or a Firebase ID token.",
    )
    .setVersion("0.1.0")
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        description: "An `nry_…` API token or a Firebase ID token.",
      },
      "bearer",
    )
    .build();
}
