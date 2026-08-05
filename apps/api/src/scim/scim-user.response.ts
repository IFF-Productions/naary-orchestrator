export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_LIST_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:ListResponse";

/**
 * A SCIM User as slice 1 renders it (RFC 7643 §4.1), trimmed to the attributes we can answer
 * truthfully. We do NOT emit `name`, `title`, `department` or any other profile attribute:
 * Naary stores none of them, and an empty-but-present attribute reads to an IdP as "we
 * cleared it", which on a bidirectional sync is a data-loss instruction.
 */
export interface ScimUser {
  schemas: [typeof SCIM_USER_SCHEMA];
  /** The STABLE ScimIdentity id — see the model docstring. This is what the IdP persists. */
  id: string;
  /** The IdP's own id for this subject, when it has told us one (slice 2). */
  externalId?: string;
  userName: string;
  emails: { value: string; primary: true }[];
  /**
   * `true` for an accepted Membership; `false` for a still-pending Invitation.
   *
   * A pending invitation is a REAL, addressable directory subject: they have been provisioned
   * here but have not completed a first sign-in (Membership.userId is a Firebase uid, which
   * does not exist until they do). Omitting them would not merely under-report — an IdP
   * reconciling against a partial directory concludes the user does not exist and CREATES
   * THEM AGAIN. So they are listed, and the difference is carried in `active`, because
   * "pending" and "absent" are different facts and only the first is one an IdP can act on.
   */
  active: boolean;
  meta: {
    resourceType: "User";
    created: string;
    lastModified: string;
    location: string;
  };
}

export interface ScimListResponse<T = ScimUser> {
  schemas: [typeof SCIM_LIST_SCHEMA];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export function scimList<T>(
  resources: T[],
  totalResults: number,
  startIndex: number,
): ScimListResponse<T> {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}
