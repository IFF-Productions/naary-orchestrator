# Companies — a cross-workspace org + admin layer

> Status: **Slices 1–4 shipped** (1 Foundation #327; 2 usage rollup #379; 3 data visibility —
> read-only runs/workflows via the company-authz path + the `/app/company` console; 4 management —
> workspace rename + soft/reversible archive (`TenantSettings.archivedAt`; archived workspaces are
> FLAGGED on /me/workspaces, never dropped) + company-member administration, owner-only add/role
> with a last-owner 409 guard). §8 decisions confirmed. Slice 4 note: it says "reuses the
> invitations machinery", which was never built (PROVISIONING-MULTIUSER §6 is design-only) —
> slice 4 adds company admins by email→uid lookup against `Membership` instead; real invitations
> land with the RBAC-GROUPS program (slice U1).

## 0. Premise (state this first — if it's wrong, everything below is)

**This design assumes: workspace = project, and Company sits ABOVE workspaces.** If instead you want
projects *inside* one workspace sharing its bill/team (a middle layer), stop here — that's a
different, much larger design. Everything below rests on "a workspace is a project; a company groups
workspaces for admin + billing rollup."

## 1. Motivation

Users want a **project**-like grouping where each project has its own flows and environments,
*plus* an org-level view — the lead ask was **billing**: a **company admin who can see the
billing / usage / data of each of the company's workspaces** and manage them.

The key realization: a **workspace already IS a project.** A workspace (`tenantId`) is the isolation
boundary that owns its own flows, environments, credentials, connections, members, and one billing
budget. So we do **not** introduce a `projectId` dimension threaded through ~15 models (that would be
a bigger effort than the entire Environments program). Instead:

**Workspace = project. Company = a grouping + admin/rollup layer ABOVE workspaces.**

```
Company (org)                         ← NEW: admin + billing/usage/data rollup
 ├─ Workspace A  (= "project")        ← existing isolation boundary (tenantId)
 │   ├─ members + budget + creds/connections
 │   ├─ flows
 │   └─ environments: sandbox / UAT / prod   (existing)
 └─ Workspace B  (= "project")
     └─ …
```

Company is **not** a new isolation dimension. No query keyed by `tenantId` gains a `companyId`.
Workspace-scoped isolation is unchanged; Company adds a *cross-workspace authorization + read-model
aggregation* path on top.

## 2. Scope boundary — what Company adds vs what stays per-workspace

### Company-level (NEW)
- `Company` entity (name, slug) + `CompanyMembership` (who administers it, role).
- A **company admin** can, across the company's workspaces: list them, view each workspace's
  **billing/usage** (aggregated + per-workspace), view each workspace's **data** (flows/runs —
  a privileged cross-workspace read), manage workspaces (attach/create/rename/archive), and manage
  company membership.
- A cross-workspace **usage/cost rollup** read model.

### Workspace-level (UNCHANGED)
- All existing isolation: flows, environments, creds/connections, endpoints, runs, per-workspace
  members/roles, the one `TenantBudget` per workspace. Billing stays **one budget per workspace** —
  the company view *aggregates* spend, it does not replace per-workspace caps (a company-level cap
  is a later, optional slice).
- Every existing `tenantId`-scoped query is untouched.

## 3. Data model (additive)

```prisma
model Company {
  id        String   @id @default(uuid())
  name      String
  slug      String   @unique
  createdAt DateTime @default(now())
  memberships CompanyMembership[]
}

// A user's role IN A COMPANY (distinct from per-workspace Membership). Keyed by the auth uid.
model CompanyMembership {
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  userId    String            // Firebase uid
  role      String @default("admin") // 'owner' | 'admin' (company-level roles; RBAC refines later)
  createdAt DateTime @default(now())
  @@id([companyId, userId])
  @@index([userId])
}
```

**No new `Workspace` table.** `TenantSettings` (keyed by `tenantId`, holds `displayName` = the
workspace name) is already the workspace record, and `Membership` is the authority for which
workspaces exist + who's in them. So the workspace↔company link is just a nullable column on
`TenantSettings` — one source of truth for the name, no parallel entity to keep in sync:

```prisma
// added to TenantSettings:
companyId String?
company   Company? @relation(fields: [companyId], references: [id], onDelete: SetNull)
@@index([companyId])
```

A company enumerates its workspaces via `TenantSettings WHERE companyId = :id` (attaching a
workspace upserts its `TenantSettings` row). `onDelete: SetNull` — deleting a company detaches its
workspaces (they revert to standalone) rather than cascading.

## 4. Authorization (the crux)

Two independent authz paths, never conflated:
- **Workspace path (unchanged):** `X-Workspace-Id` / `/tenants/:id` → `AuthGuard` resolves the
  user's `Membership` → `Principal.tenantId`. Company membership grants **no** implicit workspace
  membership on these routes — a company admin still can't hit `/tenants/:other/...` via the normal
  path.
- **Company path (NEW):** `/companies/:id/...` routes check `CompanyMembership`, then may read
  ACROSS the company's workspaces (billing/usage/data). This is the *only* place cross-workspace
  reads are allowed, and only for the company's own workspaces, only for company admins.

**Privacy note (confirm):** a company admin can *view* each member workspace's data (flows/runs).
That is a deliberate privilege of company ownership — called out so it's an explicit decision, not
an accident. Company admins get **read** across workspaces by default; write/manage is a narrower
set (rename/archive workspace; manage company members) — not editing flows inside a workspace they
aren't a member of (that stays workspace-gated) unless we later decide otherwise.

### The attach-consent invariant (SECURITY — non-negotiable)
Since company membership grants cross-workspace **read**, *how a workspace joins a company* is the
load-bearing authorization. **Attaching a workspace to a company MUST be authorized by the WORKSPACE
OWNER, never by the company admin alone.** Otherwise a company admin could create a company, attach
a victim's workspace, and gain data-read on it — privilege escalation to arbitrary workspaces.
Concretely: the workspace owner initiates/accepts the link (a two-sided handshake, or owner-only
"join this company" action). A company admin can *invite* a workspace but cannot unilaterally pull
one in. Detaching is allowed from either side. This invariant is what makes §4/§5 cross-workspace
reads safe; it is not a "later RBAC" detail.

## 5. Billing / usage / data rollup

- **Usage/cost:** `UsageEvent` is already per-tenant. The company view aggregates
  `SUM(costUsd) GROUP BY tenantId` over the company's workspaces (+ per-workspace breakdown, and —
  once Slice 6 lands — a per-environment breakdown within each). Read-only; no change to the
  billing enforcement path (still one `TenantBudget` per workspace).
- **Data:** the company console links into each workspace's existing Runs/Flows views, scoped by
  the company-authz path.
- **Optional later:** a company-level spend cap / invoice rollup across workspaces.

## 6. Migration strategy — additive, like Environments

Everything is additive and nullable-first, so existing single-workspace users are unaffected:
1. Add `Company` + `CompanyMembership` + a nullable `TenantSettings.companyId` (no new table — §3).
   A workspace lacking a `TenantSettings` row simply gets one when it's first attached to a company;
   no backfill is required until then. No behavior change.
2. Company console reads (aggregate usage, list workspaces) — read-only.
3. Cross-workspace data visibility + management actions.
No `tenantId`-scoped query changes; the compatibility burden is far lower than Environments.

## 7. Slice plan (billing-first — that was the lead ask)

1. **Foundation** — `Company` + `CompanyMembership` + `TenantSettings.companyId`; "my companies"
   resolution; **owner-authorized** attach/detach of a workspace to a company (§4 invariant); create
   a company. No cross-workspace reads yet. *(Additive; behavior-neutral.)*
2. **MVP — billing/usage rollup** — `/companies/:id/usage`: aggregate spend across the company's
   workspaces (total + per-workspace; per-env once Slice 6 lands). Read-only company-admin view.
   **This is the driver; ship it right after Foundation.**
3. *(Opt-in)* **Cross-workspace data visibility** — company admins can open each workspace's
   Runs/Flows (privileged read via the company-authz path).
4. *(Opt-in)* **Company management** — rename/archive workspaces under a company; invite company
   admins (reuses the invitations machinery).
5. *(Optional)* company-level billing rollup cap / invoicing.

Slices 3–5 are opt-in, not a committed path — confirm which you actually want after the billing view.

## 8. Decisions (CONFIRMED)

- **Naming:** surface "workspace" as **Project** in the UI, with **Company** as the org above —
  copy-only, no data-model change (isolation boundary stays `tenantId`). *(UI relabel: last slice.)*
- **Company admin data access:** **billing + data (read)** across member workspaces. The §4
  attach-consent invariant (a workspace only joins when its OWNER authorizes it) is what keeps this
  safe.
- **Membership is OPTIONAL:** `TenantSettings.companyId` is nullable; standalone workspaces keep
  working, companies are opt-in.
- **Per-company spend cap: YES** — a `CompanyBudget` enforces a company-wide monthly cap as an
  OUTER gate above per-workspace budgets (both must pass), fail-safe. Ships as its own slice (§7.3),
  after the read-only rollup.

### Slice 1 (Foundation) — SHIPPED
`Company` + uid-keyed `CompanyMembership` + nullable `TenantSettings.companyId`; `GET /me/companies`,
`POST /companies` (creator = owner), and **owner-authorized** attach/detach
(`POST|DELETE /companies/:id/workspaces/:tenantId`). Attach requires the caller to be BOTH a company
member AND the workspace owner (§4); detach is allowed from either side. Additive + behavior-neutral
— no cross-workspace reads yet. API-token principals (no uid) can't hold a company membership.

## 9. RBAC seam

Company roles (`owner`/`admin`) layer on top of the existing per-workspace roles. The env-scoped
RBAC seam (ENVIRONMENTS.md §9) and this compose: company-owner ⊃ workspace-owner ⊃ env-scoped
permissions. Designed together when RBAC lands.
