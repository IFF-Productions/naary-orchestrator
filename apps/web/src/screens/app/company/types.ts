import type { CompanyUsage } from "../../../lib/api";

export type DrillTab = "runs" | "workflows";

export interface Drill {
  tenantId: string;
  displayName: string | null;
  tab: DrillTab;
}

export type WorkspaceRow = CompanyUsage["byWorkspace"][number];
