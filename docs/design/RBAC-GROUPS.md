# RBAC-GROUPS — per-workspace permission groups, real user management, workflow tags

Status: DESIGN (slices T1/U1 may start immediately; G1 blocked on §8 sign-off).
Related: COMPANIES.md §9 (company roles compose above), ENVIRONMENTS.md §9 (env-scoped RBAC seam),
PROVISIONING-MULTIUSER.md §6–§7 (invitations — designed there, built HERE as slice U1).

## 0. Premise (state this first — if it's wrong, everything below is)

**Groups gate the `member` tier only; `owner`/`admin` — and API-token principals, and trigger-fired
runs — always bypass.** A workspace with zero grants behaves exactly as today. Grants target
workflows by `workflowKey` **tenant-wide across environments** (env-scoped grants are a §9 seam,
not v1). If you want to gate admins, or env-/company-scoped grants now, stop — that is a different
design.

Confirmed product decisions (user, Jul 2026): groups are per-workspace; a grant carries the FULL
matrix (`view` / `run` / `edit` / `delete` / `share`); tags are organizational metadata only —
grants never reference tags in v1 (the schema deliberately does not preclude tag-scoped grants
later).

## 1. Motivation

- Workspace roles are **advisory today** — the Team screen literally says so. `Member` rows (the
  Team screen's table) are read by nothing; the real authz table is `Membership` (uid-keyed,
  written only by the AuthGuard claim-backfill and workspace creation). Adding a "member" today
  grants nothing. Real customers need "these five users can run but not edit these three
  workflows" — which first requires membership to be real.
- Tags: n8n-parity organization for a growing Workflows list (filter/search). Explicitly not a
  permission scope in v1.

## 2. Scope boundary

**In:** `Tag`/`WorkflowTag`; real invitations + enforced workspace roles (U1); `PermissionGroup` /
`GroupMember` / `WorkflowGrant` (+ key list); a `PermissionsService` with in-service asserts on
the workflow surfaces; Groups + Tags UI.

**Out (with seams):** tag-scoped grants (later `TagGrant {grantId, tagId}` join beside
`WorkflowGrantKey`, union semantics — nothing in v1 blocks it); env-scoped grants (reserved shape:
`WorkflowGrant.environmentId String?`; composes with ENVIRONMENTS §9); company-level groups/roles
(COMPANIES §9: company-owner ⊃ workspace-owner/admin ⊃ group grants — designed together when
company RBAC lands); permissions on non-workflow resources (credentials, variables, budgets).

## 3. Data model (all additive)

```prisma
// ---- Tags (organizational ONLY — grants never reference these in v1) ----
model Tag {
  id        String   @id @default(uuid())
  tenantId  String
  name      String
  color     String?          // optional hex; UI offers a fixed palette
  createdAt DateTime @default(now())
  workflows WorkflowTag[]
  @@unique([tenantId, name])
  @@index([tenantId])
}

// Tags attach to (tenantId, workflowKey) TENANT-WIDE, not per env: authoring metadata like the
// workflow's name — identical in every environment; promote carries them implicitly. Soft
// reference (no FK to GraphDefinition — no single row identity across versions/envs).
model WorkflowTag {
  tagId       String
  tag         Tag      @relation(fields: [tagId], references: [id], onDelete: Cascade)
  tenantId    String
  workflowKey String
  createdAt   DateTime @default(now())
  @@id([tagId, tenantId, workflowKey])
  @@index([tenantId, workflowKey])
}

// ---- Real user management (U1) ----
model Invitation {
  id         String    @id @default(uuid())
  tenantId   String
  email      String    // matched against the VERIFIED Firebase email on login
  role       String    @default("member")
  groupIds   Json?     // permission-group ids joined on accept (used from G1 on)
  invitedBy  String    // uid of the inviting owner/admin
  createdAt  DateTime  @default(now())
  acceptedAt DateTime?
  @@unique([tenantId, email])
  @@index([email])
}

// ---- Groups + grants (G1) ----
model PermissionGroup {
  id        String   @id @default(uuid())
  tenantId  String
  name      String
  createdAt DateTime @default(now())
  members   GroupMember[]
  grants    WorkflowGrant[]
  @@unique([tenantId, name])
  @@index([tenantId])
}

model GroupMember {
  groupId   String
  group     PermissionGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  userId    String          // Firebase uid; must hold a Membership in the group's tenant
  createdAt DateTime @default(now())
  @@id([groupId, userId])
  @@index([userId])
}

// A group may hold several grants (e.g. view-all + edit-selected); effective = union.
model WorkflowGrant {
  id        String  @id @default(uuid())
  tenantId  String  // denormalized: "does ANY grant exist in tenant?" is THE restriction switch
  groupId   String
  group     PermissionGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  scope     String  // 'all' | 'selected'
  canView   Boolean @default(false)
  canRun    Boolean @default(false)
  canEdit   Boolean @default(false)
  canDelete Boolean @default(false)
  canShare  Boolean @default(false)
  workflows WorkflowGrantKey[] // only for scope='selected'
  @@index([tenantId])
  @@index([groupId])
}

model WorkflowGrantKey {
  grantId     String
  grant       WorkflowGrant @relation(fields: [grantId], references: [id], onDelete: Cascade)
  workflowKey String
  @@id([grantId, workflowKey])
}
```

Five booleans over a string-set column: queryable, typo-proof, and the matrix is fixed at five.

## 4. Authorization semantics (the crux)

**THE RULE (default access):** *a workspace with zero `WorkflowGrant` rows behaves exactly as
today (members have full access); the moment the first grant exists in the workspace,
`role='member'` users are deny-by-default across ALL workflows and get exactly the union of their
groups' grants.* Rationale: (a) migration-neutral — no tenant has grants at deploy, nothing
changes; (b) no hidden toggle state; (c) per-workflow default-allow is incoherent with
`scope='all'` grants; (d) creating the first grant IS the admin's explicit opt-in — the UI shows a
prominent "this restricts all members" warning before the first grant saves. (Alternative — an
explicit `enforceGroups` toggle — is §8 decision 1.)

- **Bypass / precedence:** `principal.role !== 'member'` ⇒ bypass. That covers workspace owners
  and admins, API tokens (the guard stamps `role: "owner"` on `nry_` principals — workspace-scoped
  secrets keep full access, env-binding already constrains them), and there is no principal at all
  on trigger-fired/scheduled runs (workspace-level automation — unaffected). Company admins reach
  data only via the `/companies` path (COMPANIES §4), which is untouched. Grants are purely
  additive — no deny rules; effective = union across all the user's groups' grants.
- **Implication:** any of run/edit/delete/share **implies view** (operating on an invisible
  workflow is incoherent). Nothing else is implied — run does not imply edit.
- **Create:** saving a NEW `workflowKey` requires an `'all'`-scope grant with `canEdit` (a
  `'selected'`-scope editor cannot mint keys outside their list).
- **Share =** `promote` (copying the workflow toward another env) **+** adding/removing that
  `workflowKey` in EXISTING `'selected'` grant key-lists. Share does NOT include creating groups,
  changing permission booleans, or managing group membership — that stays owner/admin. Tag editing
  is **edit**, not share (metadata, no access consequence).
- **Action → surface matrix** (enforced in services; list endpoints FILTER, single-resource
  endpoints 403):

| Action | Surfaces |
|---|---|
| view | graphs list (filter)/get/versions/diff/promotions/error-handler GET; pins GET; G3: execution reads scoped to viewable keys (SPA + v1) |
| run | manual start + rerun (SPA + v1); single-node test |
| edit | save (via `WorkflowLifecycleService.saveWorkflow` — covers SPA + v1), activation toggle, error-handler PUT, pins PUT/DELETE, tags PUT |
| delete | `WorkflowLifecycleService.deleteWorkflow` (SPA + v1) |
| share | `GraphsService.promote` (SPA + v1) + `'selected'` grant key-listing |
| ungated | `POST /graphs/generate` (draft only — the save is gated) |

- **Mechanism:** new `apps/api/src/permissions/permissions.service.ts` —
  `assertCan(principal, action, workflowKey)` (403), `filterViewable(principal, keys)`,
  `canCreateWorkflow(principal)`, `getEffective(principal)` (powers `GET /me/permissions` for SPA
  affordance-hiding). **In-service asserts, not route guards**: workflow routes span five
  controllers with heterogeneous key extraction, and the shared services are the only choke points
  that also cover the v1 public API for Firebase-user callers. Short-TTL per-user effective-
  permission cache modeled on `membership-cache.ts`, invalidated on group/grant writes.
- **Role management hardening (U1, prerequisite):** member add/remove/role-change requires
  `owner|admin`; only `owner` grants or revokes `admin`/`owner`; the last owner can be neither
  removed nor demoted. Group/grant CRUD requires `owner|admin`. NOTE: today the members routes
  have NO role checks — harmless while the table is inert, a real hole once membership is real;
  U1 ships the gates in the same slice.

## 5. User management (Member → Membership + Invitation, slice U1)

- Team screen + members module become **Membership-backed**: list = `Membership WHERE tenantId` ∪
  pending `Invitation`s; add = create `Invitation`; remove = delete `Membership` (or revoke the
  invitation); role change = update `Membership.role` — all role-gated per §4.
- **Accept-on-login:** beside the AuthGuard claim→Membership backfill, a **verified-email** match
  against pending `Invitation`s converts them to `Membership` (+ `GroupMember` rows from
  `groupIds`) and stamps `acceptedAt`. Verified email is required — an unverified account must not
  claim an invited address. Same swallow-and-log, non-authorizing error posture as the backfill.
- The inert `Member` table: one-time seed of `Invitation`s from `Member` rows lacking a matching
  `Membership` (email join). Where a `Membership` exists, **its role wins** — advisory `Member`
  roles are never auto-promoted onto real memberships (silent escalation). `Member` + its module
  retire in G3.

## 6. Migration / rollout

Everything additive and behavior-neutral at every step: new tables only; no existing keys change;
zero grants ⇒ §4 keeps every member fully functional until an admin opts in; API tokens, triggers,
and v1 token callers unchanged. The two deliberate behavior changes are U1's members-route role
gates (a security fix, flagged in its PR) and the Member→Invitation seed.

## 7. Slice plan

- **T1 — Tags end-to-end** (zero authz risk): Tag/WorkflowTag + tags module + workflow-list chips,
  filter, editor dialog. *Shippable immediately.*
- **U1 — Real user/role management**: Invitation + accept-on-login + Membership-backed Team +
  role gates + Member seed. *Prerequisite for G1 (groups reference real uids).*
- **G1 — Groups + grants + enforcement (API-only)**: schema + PermissionsService + asserts on the
  §4 matrix surfaces + groups CRUD API + `GET /me/permissions`. *Blocked on §8 sign-off.*
- **G2 — Groups UI + grant matrix**: Groups screen (create, member picker, scope toggle ×
  five-checkbox matrix, first-grant warning); SPA affordance gating from `/me/permissions`.
- **G3 — Long tail**: v1 coverage specs; execution-read scoping to viewable keys (widest blast
  radius — Runs/insights screens); audit labels for group/grant/member mutations; retire `Member`.

## 8. Decisions (OPEN — confirm before G1; recommendations bolded)

1. **Default-access cliff**: **first grant flips members to deny-by-default** (recommended) vs an
   explicit `enforceGroups` workspace toggle. The cliff is toggle-free and migration-neutral; the
   toggle is more discoverable but adds state.
2. **Share semantics**: **promote + `'selected'` grant key-listing** (recommended) vs promote-only.
3. **Create rule**: **members need an `'all'`-scope `canEdit` grant to create workflows**
   (recommended) vs any-edit-anywhere vs owner/admin-only.
4. **Run-read visibility deferred to G3**: until then a restricted member can see run ROWS (names,
   statuses, costs) of workflows they cannot open. **Accept the interim leak** (recommended) or
   pull G3's read-scoping into G1.
5. **Grants are tenant-wide across envs in v1** (a member with edit can edit in any env they can
   select). Env-scoped grants (incl. a future `promote:prod`) are §9 seams. **Accept for v1.**

## 9. Seams

Tag-scoped grants (`TagGrant` beside `WorkflowGrantKey`, union semantics); env-scoped grants
(`WorkflowGrant.environmentId?`); company-role composition (COMPANIES §9); `Promotion` rows remain
the promote audit substrate (ENVIRONMENTS §6).
