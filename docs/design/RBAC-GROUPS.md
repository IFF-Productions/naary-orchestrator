# RBAC-GROUPS — per-workspace permission groups, real user management, workflow tags

Status: DESIGN — **§8 CONFIRMED (user, Jul 18 2026); G1 unblocked.** T1 shipped (#387).
Related: COMPANIES.md §9 (company roles compose above), ENVIRONMENTS.md §9 (env-scoped RBAC seam).
Invitations: PROVISIONING-MULTIUSER.md §6–§7 designed a token-based flow
(`tokenHash`/`expiresAt` + `POST /invitations/:token/accept`) that was never built. **This doc
SUPERSEDES that flow** — U1 ships verified-email accept-on-login instead (§5, rationale there);
update PROVISIONING-MULTIUSER.md to point here when U1 lands. This doc is the source of truth
for invitations.

## 0. Premise (state this first — if it's wrong, everything below is)

**Groups gate the `member` tier AND API tokens; `owner`/`admin` users and trigger-fired runs
bypass.** A workspace with zero grants behaves exactly as today — for members AND tokens — and
the FIRST grant flips both to deny-by-default (§4, §4a). Grants target workflows by `workflowKey`
and are **environment-scoped**: a grant applies to all environments (null) or exactly one. If you
want to gate admins, or company-scoped grants now, stop — that is a different design.

Confirmed product decisions (user, Jul 2026 — full list §8): groups are per-workspace; a grant
carries a SIX-verb matrix (`view` / `run` / `edit` / `delete` / `share`=promote /
`create`); grants are env-scoped from v1; tags were organizational metadata only in v1 — the
tag-scoped-grant seam has since SHIPPED (`TagGrant`, §3/§9: 'selected' grants may name tags,
union semantics, tag edits share-gated once a tenant adopts them);
**API tokens are RBAC subjects, restricted by default** under the same first-grant cliff (§4a).

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
`WorkflowGrantKey`, union semantics — nothing in v1 blocks it); company-level groups/roles
(COMPANIES §9: company-owner ⊃ workspace-owner/admin ⊃ group grants — designed together when
company RBAC lands); permissions on non-workflow resources (credentials, variables, budgets).
(Env-scoped grants were originally a seam here — §8.5 pulled them INTO v1.)

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

// API tokens as grant subjects (§4a). A SEPARATE join (not a polymorphic subject column on
// GroupMember): both FKs stay honest and Cascade — deleting a token or a group cleans its rows.
// Under §8.6 the workspace's first-grant cliff restricts tokens too; these rows are how a
// restricted token gets its access BACK (union of its groups' grants).
model GroupTokenMember {
  groupId   String
  group     PermissionGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  tokenId   String
  token     ApiToken        @relation(fields: [tokenId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
  @@id([groupId, tokenId])
  @@index([tokenId])
}

// A group may hold several grants (e.g. view-all + edit-selected); effective = union.
model WorkflowGrant {
  id            String  @id @default(uuid())
  tenantId      String  // denormalized: "does ANY grant exist in tenant?" is THE restriction switch
  groupId       String
  group         PermissionGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  // Env-scoped (§8.5 CONFIRMED — tenant-wide-only was rejected): null = every environment,
  // set = that environment only. Cascade FK: a grant naming a deleted env should vanish.
  environmentId String?
  environment   Environment? @relation(fields: [environmentId], references: [id], onDelete: Cascade)
  scope         String  // 'all' | 'selected'
  canView       Boolean @default(false)
  canRun        Boolean @default(false)
  canEdit       Boolean @default(false)
  canDelete     Boolean @default(false)
  canShare      Boolean @default(false) // share = PROMOTE only (§8.2)
  // §8.3 (user-proposed): creation is its OWN permission, never inferred from edit. Valid ONLY
  // on scope='all' grants (400 otherwise) — a 'selected'-scope creator would immediately lose
  // sight of their own new workflow, which is incoherent.
  canCreate     Boolean @default(false)
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

// Tag-scoped grants (§9 seam, SHIPPED): a 'selected'-scope grant may also name TAGS — its
// effective keys = its WorkflowGrantKey list ∪ the workflowKeys carrying ANY of its tags
// (union semantics, resolved at read time from WorkflowTag and baked into the cached
// flattened keys, so downstream matching is unchanged). Both FKs Cascade: deleting a grant
// or a tag cleans its rows (a deleted tag simply stops carrying access). Because tag
// MEMBERSHIP then carries access, tag edits are share-gated in adopting tenants — see §4.
model TagGrant {
  grantId   String
  grant     WorkflowGrant @relation(fields: [grantId], references: [id], onDelete: Cascade)
  tagId     String
  tag       Tag           @relation(fields: [tagId], references: [id], onDelete: Cascade)
  createdAt DateTime      @default(now())
  @@id([grantId, tagId])
  @@index([tagId])
}
```

Six booleans over a string-set column: queryable, typo-proof, and the matrix is fixed at six
(view/run/edit/delete/share/create).

## 4. Authorization semantics (the crux)

**THE RULE (default access):** *a workspace with zero `WorkflowGrant` rows behaves exactly as
today (members have full access); the moment the first grant exists in the workspace,
`role='member'` users are deny-by-default across ALL workflows and get exactly the union of their
groups' grants.* Rationale: (a) migration-neutral — no tenant has grants at deploy, nothing
changes; (b) no hidden toggle state; (c) per-workflow default-allow is incoherent with
`scope='all'` grants; (d) creating the first grant IS the admin's explicit opt-in — the UI shows a
prominent "this restricts all members" warning before the first grant saves. (Alternative — an
explicit `enforceGroups` toggle — is §8 decision 1.)

- **Bypass / precedence:** owner/admin USERS bypass; `member` users are gated per THE RULE;
  API tokens are gated per §4a below; there is no principal at all on trigger-fired/scheduled
  runs (workspace-level automation — unaffected). Company admins reach data only via the
  `/companies` path (COMPANIES §4), which is untouched. Grants are purely additive — no deny
  rules; effective = union across all of the subject's groups' grants.
- **Implication:** any of run/edit/delete/share **implies view** (operating on an invisible
  workflow is incoherent). Nothing else is implied — run does not imply edit.
- **Env-scoped resolution (§8.5):** every permission check carries the request's RESOLVED
  environment (the same `resolveEnvId` boundary every env-scoped feature uses). A grant matches
  when its `environmentId` is null (all envs) or equals the request's env. So "run in prod only"
  is one grant with `environmentId = prod`; the UI's grant editor gains an environment selector
  defaulting to "All environments".
- **Create (§8.3, user-proposed):** saving a NEW `workflowKey` requires a grant with
  **`canCreate`** — its own permission, never inferred from edit. `canCreate` is valid only on
  `'all'`-scope grants (400 otherwise): a `'selected'`-scope creator would immediately lose sight
  of their own new workflow. Env-scoping applies: `canCreate` in sandbox lets you create in
  sandbox only.
- **Share = `promote` only (§8.2):** the permission to copy the workflow toward another
  environment. Share does NOT include editing grant key-lists, creating groups, changing
  permission booleans, or managing group membership — all of that stays owner/admin. The share
  grant must match the promote's SOURCE environment.
- **Tag editing is CONDITIONALLY gated (user-confirmed, with tag-scoped grants):** while the
  tenant has ZERO `TagGrant` rows, `tags PUT` is the **edit** verb (v1 behavior —
  migration-neutral). The moment the workspace has ≥1 `TagGrant`, tag membership carries
  access, so `tags PUT` requires **share** (promote) on that workflow instead — otherwise an
  edit-only member could grant themselves (or others) access just by tagging a workflow. The
  403 explains why ("tags carry permissions in this workspace — promoting rights are required
  to change them"). The switch is a cheap cached existence check beside the first-grant cliff.
- **Action → surface matrix** (enforced in services; list endpoints FILTER, single-resource
  endpoints 403):

| Action | Surfaces |
|---|---|
| view | graphs list (filter)/get/versions/diff/promotions/error-handler GET; pins GET; G3: execution reads scoped to viewable keys (SPA + v1) |
| run | manual start + rerun (SPA + v1); single-node test |
| edit | save (via `WorkflowLifecycleService.saveWorkflow` — covers SPA + v1), activation toggle, error-handler PUT, pins PUT/DELETE, tags PUT *while the tenant has zero TagGrants* |
| delete | `WorkflowLifecycleService.deleteWorkflow` (SPA + v1) |
| share | `GraphsService.promote` (SPA + v1) + `'selected'` grant key-listing + tags PUT *once the tenant has ≥1 TagGrant* (tags are then access-bearing) |
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

### 4a. API tokens as RBAC subjects (confirmed Jul 18)

- **Today's mechanics to change:** the AuthGuard stamps `role: "owner"` on every `nry_` principal
  (auth.guard.ts:148) and `ApiTokenService.verify` deliberately returns `{tenantId,
  environmentId}` with NO token id — there is currently no identity to hang a grant on. G1 makes
  `verify` additionally return the token's row id (additive) and `Principal` gains `tokenId?`.
- **Default (§8.6 CONFIRMED — restricted by default): tokens fall under the SAME first-grant
  cliff as members.** Zero grants in the workspace ⇒ tokens work exactly as today (migration is
  still a no-op). The moment the first grant exists, UNGROUPED tokens are deny-by-default too —
  the workspace has opted into enforcement, and a secret that bypasses it would be the weakest
  link. Consequence the UI must own: the first-grant warning says it restricts **all members AND
  all API tokens**, and the grant editor's token picker sits right there so CI/MCP tokens get
  grouped in the same gesture. Grouped tokens get exactly the union of their groups' grants
  (same math as users: implies-view, canCreate on 'all'-scope, share=promote, env matching).
- **Guard/enforcement mechanics:** the guard already reads the token row to verify it — it
  additionally learns "is restricted?" (a `_count` on the join in the same lookup) and stamps
  `role: "member"` + `tokenId` for restricted tokens instead of `"owner"`.
  `PermissionsService` resolves grants by `tokenId` when set, by `userId` otherwise; nothing else
  changes, so the v1 public API, MCP server, and CLI callers inherit enforcement automatically
  (they all authenticate with `nry_` tokens through the same services).
- **Composition with env-binding:** unchanged and orthogonal — env-binding restricts WHERE a
  token may act (which environment); grants restrict WHAT it may touch (which workflows, which
  verbs). Both apply.
- **Managing token groups** is owner/admin-only, on the same Groups surface (G2 adds a token
  picker beside the member picker; the API-tokens screen shows a "restricted" badge listing the
  token's groups).
- Trigger-fired and scheduled runs remain workspace-level automation with no principal —
  unaffected.

## 5. User management (Member → Membership + Invitation, slice U1)

> **Deliberate change from PROVISIONING-MULTIUSER.md §6–§7** (which specified token links —
> `tokenHash`/`expiresAt` + `POST /invitations/:token/accept`, never implemented): U1 uses
> **accept-on-login by verified-email match** instead. Rationale: no out-of-band token channel
> exists yet (no email sending), a copy-pasteable token is a phishable secret, and the
> verified-email match gives the same guarantee the token flow's security matrix wanted ("verified
> email must equal the invite email") with zero new endpoints. A token flow can be layered on
> later for invite-by-link without schema changes (add `tokenHash`/`expiresAt` columns then).
> PROVISIONING-MULTIUSER.md gets a pointer to this section when U1 lands.

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
zero grants ⇒ §4/§4a keep every member AND every token fully functional until an admin opts in by
creating the first grant (existing CI/MCP/v1 callers are unchanged at deploy — the cliff only
moves when a workspace adopts groups, and the first-grant warning + token picker make the token
impact explicit in that flow); triggers unaffected. The two deliberate behavior changes are U1's
members-route role gates (a security fix, flagged in its PR) and the Member→Invitation seed.

## 7. Slice plan

- **T1 — Tags end-to-end** (zero authz risk): Tag/WorkflowTag + tags module + workflow-list chips,
  filter, editor dialog. *Shippable immediately.*
- **U1 — Real user/role management**: Invitation + accept-on-login + Membership-backed Team +
  role gates + Member seed. *Prerequisite for G1 (groups reference real uids).*
- **G1 — Groups + grants + enforcement (API-only)**: schema (incl. `GroupTokenMember`) +
  PermissionsService + asserts on the §4 matrix surfaces + groups CRUD API (member AND token
  attachment) + `GET /me/permissions` + the §4a guard/verify changes (`tokenId` in the principal;
  restricted tokens stamped `member`). *Blocked on §8 sign-off.*
- **G2 — Groups UI + grant matrix**: Groups screen (create, member picker + TOKEN picker, scope
  toggle × five-checkbox matrix, first-grant warning); SPA affordance gating from
  `/me/permissions`; "restricted" badge + group list on the API-tokens screen.
- **G3 — Long tail**: v1 coverage specs; execution-read scoping to viewable keys (widest blast
  radius — Runs/insights screens); audit labels for group/grant/member mutations; retire `Member`.

## 8. Decisions (CONFIRMED — user, Jul 18 2026)

1. **Default access: the first-grant cliff.** Zero grants = today's behavior; the first grant in
   a workspace flips `member` users (and, per 6, ungrouped tokens) to deny-by-default. No toggle.
2. **Share = promote only.** No grant-key-listing power for members; all grant editing stays
   owner/admin.
3. **Create is its OWN permission** (user-proposed): a sixth `canCreate` boolean, valid only on
   `'all'`-scope grants — never inferred from edit.
4. **Run-read scoping deferred to G3 accepted** — interim: restricted subjects can see run rows
   (names/statuses/costs) of workflows they cannot open.
5. **Grants are ENV-SCOPED from v1** (tenant-wide-only rejected): `WorkflowGrant.environmentId`
   nullable — null = all environments, set = that one. Every check resolves against the request's
   env; "edit in sandbox, run-only in prod" is expressible on day one.
6. **Tokens are restricted by default**: same first-grant cliff as members — once a workspace
   opts into enforcement, an ungrouped token is denied like an ungrouped member. The first-grant
   UI warning covers tokens explicitly and the token picker sits in the same flow.

## 9. Seams

Tag-scoped grants (`TagGrant` beside `WorkflowGrantKey`, union semantics) — **SHIPPED** (§3
model; grantsFor expands tag-carried keys into the cached flattened list; tag edits become
share-gated in adopting tenants per §4; cost insights/usage are filtered to the subject's
viewable workflows via the shared view-terms helper). Env-scoped grants
(`WorkflowGrant.environmentId?`) — shipped in v1 (§8.5). Still open: company-role composition
(COMPANIES §9); `Promotion` rows remain the promote audit substrate (ENVIRONMENTS §6).
