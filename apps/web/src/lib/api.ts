/**
 * Thin client for the NestJS control plane (apps/api) — BARREL.
 *
 * The implementation lives in ./api/* (split per the large-files check), but this
 * module remains the single import surface: `import { api, X } from "../lib/api"`
 * keeps working unchanged for every screen.
 *
 * - ./api/http — base fetch, auth/workspace/env headers, error classes, and the
 *   active workspace/environment module state (single instance — everything
 *   routes through that one module).
 * - ./api/types — every shared view-model type (re-exported wholesale below).
 * - ./api/{runs,graphs,workspaces,companies,notifications,config,integrations}
 *   — the domain method fragments merged into the `api` object below.
 *
 * In dev, Vite proxies /api → http://localhost:3000 (see vite.config.ts), so the
 * browser avoids CORS.
 *
 * Auth: every call carries a bearer token — a fresh Firebase ID token when the
 * user is signed in, else the pasted `nry_` API token (see getBearerToken). The
 * server resolves tenantId from the token, so the client never sends it.
 */
import { companiesApi } from "./api/companies";
import { configApi } from "./api/config";
import { graphsApi } from "./api/graphs";
import { integrationsApi } from "./api/integrations";
import { notificationsApi } from "./api/notifications";
import { permissionsApi } from "./api/permissions";
import { runsApi } from "./api/runs";
import { workspacesApi } from "./api/workspaces";

export {
  AccessNotAllowedError,
  getActiveEnvironment,
  getActiveWorkspace,
  HttpError,
  setActiveEnvironment,
  setActiveWorkspace,
  subscribeActiveEnvironment,
  UnauthorizedError,
} from "./api/http";
export * from "./api/types";

export const api = {
  ...graphsApi,
  ...runsApi,
  ...workspacesApi,
  ...companiesApi,
  ...notificationsApi,
  ...permissionsApi,
  ...configApi,
  ...integrationsApi,
};
