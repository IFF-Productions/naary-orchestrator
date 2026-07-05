import { SetMetadata } from "@nestjs/common";

/**
 * Marks a route as needing only an authenticated USER — not membership in a workspace.
 * Used for identity/onboarding routes (`/me`, the workspace switcher, create-workspace)
 * that a user with no workspace yet must still reach.
 *
 * The AuthGuard still authenticates the bearer token (401 if missing/invalid); it only
 * skips the active-workspace membership check, which otherwise 403s a user with no
 * resolvable workspace. Everything NOT marked is workspace-scoped and fails CLOSED — so
 * a tenant-less principal can never fall through to a shared empty-tenant data query.
 */
export const IS_USER_SCOPED_KEY = "isUserScoped";
export const UserScoped = () => SetMetadata(IS_USER_SCOPED_KEY, true);
