import { applyDecorators, type Type } from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
} from "@nestjs/swagger";
import { ErrorResponse } from "./error-response.dto";

/**
 * The standard error responses every authenticated endpoint can return (401/403 from the guard,
 * 400 from the ValidationPipe, 500 from the exception filter). Apply at the CLASS level to cover
 * a whole controller; pass `{ notFound: true }` on routes that look up a resource by id.
 */
export function ApiStandardErrors(
  opts: { notFound?: boolean } = {},
): ClassDecorator & MethodDecorator {
  const decs = [
    ApiResponse({
      status: 400,
      description: "Validation error / malformed request.",
      type: ErrorResponse,
    }),
    ApiResponse({
      status: 401,
      description: "Missing or invalid credentials (bearer token).",
      type: ErrorResponse,
    }),
    ApiResponse({
      status: 403,
      description: "Authenticated but not permitted for this workspace.",
      type: ErrorResponse,
    }),
    ApiResponse({
      status: 500,
      description: "Unexpected server error.",
      type: ErrorResponse,
    }),
  ];
  if (opts.notFound) {
    decs.push(
      ApiResponse({
        status: 404,
        description: "Resource not found.",
        type: ErrorResponse,
      }),
    );
  }
  return applyDecorators(...decs);
}

/**
 * One decorator per endpoint that bundles the summary, the success response, and the standard
 * error responses — so a controller method stays a one-liner instead of a stack of @Api* calls.
 *
 *   @ApiEndpoint({ summary: "Save a graph", ok: SaveGraphResponse })
 *   @ApiEndpoint({ summary: "Create a workspace", created: WorkspaceView, notFound: true })
 */
export function ApiEndpoint(opts: {
  summary: string;
  description?: string;
  /** Success (200) response type. Use `[Type]` for an array. */
  ok?: Type<unknown> | [Type<unknown>];
  /** 201 Created response type (for POSTs that create a resource). */
  created?: Type<unknown>;
  /** Add a 404 (for routes that resolve a resource by id). */
  notFound?: boolean;
}): MethodDecorator {
  const decs: (MethodDecorator | ClassDecorator)[] = [
    ApiOperation({ summary: opts.summary, description: opts.description }),
    ApiStandardErrors({ notFound: opts.notFound }),
  ];
  if (opts.ok) decs.push(ApiOkResponse({ type: opts.ok }));
  if (opts.created) decs.push(ApiCreatedResponse({ type: opts.created }));
  return applyDecorators(...decs);
}
