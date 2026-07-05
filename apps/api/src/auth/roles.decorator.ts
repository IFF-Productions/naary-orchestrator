import { SetMetadata } from "@nestjs/common";

export type Role = "owner" | "admin" | "member";

/** Numeric rank for the role hierarchy: owner > admin > member. */
export const ROLE_RANK: Record<Role, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

export const ROLES_KEY = "requiredRole";

/**
 * Require at least this role on a route (owner > admin > member). Enforced by RolesGuard,
 * which is applied per-controller via `@UseGuards(RolesGuard)` — NOT globally — so it's
 * guaranteed to run after the global AuthGuard (which populates `principal.role`) and never
 * touches `@UserScoped()` routes (whose principals carry no role).
 */
export const Roles = (min: Role) => SetMetadata(ROLES_KEY, min);
