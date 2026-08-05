import { HttpException } from "@nestjs/common";

/** RFC 7644 §3.12 — SCIM speaks its own error envelope, and IdPs parse it. A bare Nest
 *  exception would render Nest's `{statusCode,message,error}` shape, which Okta/Entra log as
 *  an unparseable response rather than as the specific failure it was. */
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

/** The `scimType` values this surface can actually produce (RFC 7644 §3.12 table). */
export type ScimErrorType =
  "invalidFilter" | "invalidValue" | "tooMany" | "uniqueness" | "mutability";

export interface ScimErrorBody {
  schemas: [typeof SCIM_ERROR_SCHEMA];
  status: string; // SCIM sends the code as a STRING, not a number
  scimType?: ScimErrorType;
  detail: string;
}

/**
 * A SCIM-shaped failure.
 *
 * `detail` is written for an IdP admin reading a sync log, and must never distinguish "no
 * such resource" from "that resource belongs to another workspace" — the 404 for a
 * cross-tenant id is the SAME 404 as for a nonexistent one, or the endpoint becomes an
 * existence oracle for other tenants' user ids.
 */
export class ScimError extends HttpException {
  constructor(status: number, detail: string, scimType?: ScimErrorType) {
    const body: ScimErrorBody = {
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(status),
      detail,
      ...(scimType ? { scimType } : {}),
    };
    super(body, status);
  }

  /** The only 404 this surface emits. Deliberately identical for "absent" and "another
   *  tenant's" — see the class docstring. */
  static notFound(): ScimError {
    return new ScimError(404, "Resource not found.");
  }

  static unauthorized(): ScimError {
    return new ScimError(401, "Invalid or missing SCIM credentials.");
  }

  static invalidFilter(detail: string): ScimError {
    return new ScimError(400, detail, "invalidFilter");
  }

  /** A payload we understood and refused: a bad `userName`, a domain outside the connection's
   *  allowlist, an `active` value this slice does not implement. */
  static invalidValue(detail: string): ScimError {
    return new ScimError(400, detail, "invalidValue");
  }

  /** RFC 7644 §3.3 — a POST for a subject this workspace already holds. The IdP's documented
   *  recovery is to GET by `userName` filter and reconcile, which slice 1 already serves. */
  static conflict(detail: string): ScimError {
    return new ScimError(409, detail, "uniqueness");
  }

  /**
   * A write this connection is not permitted to make — today, only de-provisioning a member
   * whose role is `owner` or `admin` (see {@link ScimProvisioningService}).
   *
   * DELIBERATELY DISTINCT FROM 404. The cross-tenant 404 must stay an opaque "no such
   * resource"; this one is about a resource the connection can plainly see and was refused,
   * and an IdP admin reading a sync log needs to tell "your token is scoped elsewhere" from
   * "this person is an admin here, change their role first". It leaks nothing across a tenant
   * boundary because reaching it already required a tenant-scoped id.
   */
  static forbidden(detail: string): ScimError {
    return new ScimError(403, detail, "mutability");
  }
}
