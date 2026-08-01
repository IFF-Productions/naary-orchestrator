# Design — LDAP / directory support (#1037)

**Roadmap line:** *"SSO SAML & LDAP — XL. SAML is SHIPPED (`apps/api/src/sso/`); LDAP is not
started."* ([ROADMAP-ENTERPRISE.md](../ROADMAP-ENTERPRISE.md) §E)

> Sibling of [SAML-SSO.md](./SAML-SSO.md), which shipped the other half of that line. This doc
> replaces the "What LDAP would take" stub at the end of [../sso-testing.md](../sso-testing.md).

**This is a connectivity design before it is an auth design, and its conclusion is that we
should probably not build LDAP.** That is an argument below, not a dismissal.

---

## 0. Premise (state this first — if it's wrong, everything below is)

SAML slotted in beside Firebase because **the IdP comes to us**: a browser POSTs a signed
assertion to a public ACS, and the whole feature is a verification problem. `apps/api/src/sso/`
is 8 files and no new network direction.

**LDAP inverts that.** It is a pull protocol over TCP 389/636 against a server that, in the
deployments that ask for it, sits inside a private network behind a firewall. Every hard
question in this document — the SSRF guard, the bind credential, the sync scheduler, the
failure mode when the directory is unreachable — descends from that one fact. If the premise is
wrong (i.e. the asking customer's directory is already internet-reachable, or already fronted
by Entra/ADFS), most of this doc collapses and the answer is "use the SAML path that ships."

---

## 1. What exists today

| | |
| --- | --- |
| **SAML 2.0** | Shipped. IdP-initiated, assertion verified in `apps/api/src/sso/saml.ts`, session minted as an `nrys_` compact JWS (`sso-session.service.ts`), consumed by the guard branch at `apps/api/src/auth/auth.guard.ts:246-249`. |
| **JIT provisioning** | Shipped. `SsoService.resolveUser` (`sso.service.ts:261-299`) links an existing `Membership(tenantId, email)`, honours a pending `Invitation`, or auto-provisions with the *connection's* `defaultRole`. |
| **Per-workspace permission groups** | Shipped. `PermissionGroup` / `GroupMember` / `WorkflowGrant` (`packages/db/prisma/schema.prisma:790+`), resolved by `PermissionsService.grantsFor` (`apps/api/src/permissions/permissions.service.ts:344-415`). |
| **LDAP** | **Zero code.** `grep -ri ldap` over the repo returns roadmap prose, this doc, and `docs/n8n-integration-catalog.ts:277` (`status: 'planned'`). |

So the gap is **not** "enterprise auth". It is specifically *directory-sourced* identity and
group membership for a directory that does not speak SAML.

---

## 2. The collision: our SSRF guard blocks exactly the address space LDAP lives in

`packages/connections/src/egress.ts` is deliberate and absolute:

- `assertEgressAllowed` refuses anything that isn't `https:` (`egress.ts:198`) — so it cannot
  apply to `ldap://` or `ldaps://` at all.
- `isBlockedIp` rejects `10/8`, `127/8`, `172.16/12`, `192.168/16`, `169.254/16`, CGNAT
  `100.64/10`, `fc00::/7`, `fe80::/10`, and the v4-in-v6 spellings (IPv4-mapped, NAT64
  `64:ff9b::/96`, 6to4, Teredo) — the last group being the actual bypass behind #590.
- `resolvePinnedHost` rejects a host if **any** address in the record set is internal, on the
  grounds that a mixed record set is what rebinding looks like (`egress.ts:158-166`), and
  returns the one address the caller must connect to.
- There is **no relaxation switch**. `EGRESS_*` appears in the tree only as
  `ApplicationFailure` type strings (`sql.ts:172`, `email.ts:148`, `feeds.ts:124`, …). The only
  place the guard is ever loosened is a test seam:
  `activities.__sqlDeps.resolvePinnedHost = async (host) => host`
  (`apps/worker/test/sql-node.integration.spec.ts:48`).

The non-HTTP precedent for reaching a wire protocol is already established, and LDAP would
follow it exactly: `apps/worker/src/temporal/activities/sql.ts:117-119` resolves the DSN host
once and passes `pinnedHost` to the driver. Note the subtlety in `packages/sql/src/pin.ts:12-15`
— the DSN keeps its **original hostname**, so each driver still derives its TLS servername from
it and certificate validation is unchanged; only the socket is redirected. (`smtp-pin.ts` does
the opposite because nodemailer re-resolves: it rewrites the host to the literal IP and then
sets an explicit `servername=` so the cert is still checked against the name.)

**But the guard's reason matters more than its mechanics.** It exists because the target URL is
**tenant-supplied** — a workspace admin types it, and we then connect with a credential
attached. Contrast `SANDBOX_RUNNER_URL` (`apps/worker/src/temporal/code-agent-write.ts:52`),
which the worker calls with a **plain `fetch` and no guard whatsoever**
(`code-agent-write.ts:160`) because it is operator-configured infrastructure. Two different
trust classes, two different rules.

That distinction is the whole connectivity design. The question is not "how do we get through
the firewall" — it is **"can an LDAP target ever be in the operator trust class?"**

---

## 3. Connectivity: five candidates, one recommendation

| Option | Verdict |
| --- | --- |
| **Relax the guard for LDAP** (per-tenant "allow private addresses" flag) | **No.** It re-opens SSRF for every tenant that ticks it: a bind against `ldap://10.0.0.5` with an attacker-chosen host is a port scanner and a credential-exfiltration primitive against our own Postgres/Temporal hosts. The guard has no such flag today on purpose. |
| **Tunnel** (Cloudflare Tunnel / WireGuard per tenant) | **No.** `deploy/docker-compose.prod.yml:152` already runs `cloudflared`, so the tech is present — but a per-tenant inbound tunnel makes us the operator of N network paths into N customer networks. That is an ops product, not a feature, and its blast radius is "our control plane has a route into your LAN". |
| **Static-IP-allowlisted egress** (customer opens 636 to our known addresses) | **No, on its own.** It only works when the directory is internet-exposed anyway, and it pins us to fixed egress IPs forever (we deploy to a Hetzner VPS + Neon today — `deploy/terraform/`). It is a deployment constraint masquerading as a design. |
| **Customer-exposed LDAPS endpoint** (a public `ldaps://` host we connect to) | **Conditional yes** — see §3.2. Mechanically clean; organisationally rare. |
| **SCIM 2.0 push + the SAML JIT that already ships** | **RECOMMENDED.** See §3.1. |

### 3.1 Recommendation: SCIM, because it inverts the direction of the connection

Every problem in §2 exists because LDAP is **pull**. SCIM is **push**: the customer's IdP
(Entra, Okta, Google Workspace, JumpCloud, OneLogin — and, via Entra Connect, on-prem AD) calls
*our* public HTTPS endpoint on user create/update/delete and group change.

What that buys, concretely:

- **The SSRF guard is not in the path.** We make no outbound connection, so `egress.ts` never
  runs. Nothing to relax, nothing to pin, nothing to tunnel.
- **We hold no bind credential.** CLAUDE.md Tier-1 §4 is satisfied by *absence* rather than by
  careful handling — there is no directory password in `TenantCredential` to encrypt, rotate,
  or leak. The only secret is a bearer token **we** issue, which we can rotate unilaterally and
  which is already the shape of `ApiTokenService` (`nry_`).
- **No scheduler.** §8 shows we have no periodic-job machinery to reuse; a push model needs
  none, and de-provisioning is near-real-time instead of "next sync".
- **It composes with what shipped.** SAML gives authentication + JIT; SCIM gives lifecycle
  (de-provisioning is the thing JIT can't do). `SAML-SSO.md:296` already lists "SCIM
  provisioning / de-provisioning" as deferred — this is that deferral coming due, and it is a
  *smaller* piece of work than LDAP, not a bigger one.
- **It is what the market settled on.** `sso-testing.md:177-179` already says the quiet part:
  most AD deployments front SAML via ADFS or Entra ID. The same IdPs that front SAML also speak
  SCIM.

The cost is honest: SCIM does not help a customer running **only** a bare OpenLDAP/389-DS with
no IdP in front of it. That customer exists. §3.2 is for them.

### 3.2 The fallback, if a real customer has a bare directory: a customer-run connector

Not "run a Naary worker inside your network". A Temporal worker needs `DATABASE_URL` and
`ENCRYPTION_KEY` to read anything from `SecretStore` (`packages/secrets/src/secret-store.ts`,
`tenant-keys.ts`) — handing a customer our database credentials to solve a firewall problem is
strictly worse than the firewall problem.

The shape that actually transfers is **`apps/sandbox-runner`**: a small, separately deployed
service the operator runs, addressed by an env-configured URL, authenticated with a shared
bearer token, doing one job in an isolated network
(`code-agent-write.ts:52-53`, `:156-172`; `deploy/sandbox/docker-compose.sandbox.yml`).
Inverted for LDAP, that is:

- The connector runs **inside the customer's network**, next to the directory.
- It holds the **bind DN + password in its own environment**. The credential never reaches our
  database, our logs, our spans, or Temporal — Tier-1 §4 by construction, not by discipline.
- It connects **outbound only** to our public API (`POST /scim/v2/...` or a dedicated
  `/directory/sync` ingest), authenticated with a per-connection token we issue. No inbound
  hole, no tunnel, no static IPs.
- It is therefore **the SCIM client**, which means §3.1 and §3.2 share one server-side
  implementation. We build the receive side once.

That last point is the argument for this ordering: **the fallback is a client for the
recommended design, not a second design.** If we build SCIM ingest and never ship the
connector, customers with an IdP are served. If a bare-directory customer appears, the
connector is an additive, self-contained artifact — and if they'd rather write their own
against a documented endpoint, they can.

### 3.3 If the deployment is self-hosted, the question changes

Naary self-hosts (`deploy/docker-compose.prod.yml`, `deploy/README.md`). If the tenants asking
for LDAP run their **own** Naary instance inside their own network, the directory is on the
same network and there is no firewall to cross — the only obstacle is the guard, and the target
is genuinely operator-configured. That is the `SANDBOX_RUNNER_URL` trust class, and the honest
implementation is an **operator env var** (`LDAP_URL`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`),
never a per-tenant DB row, never a guard flag. One instance, one directory, no multi-tenant
trust question at all.

**This is decision 2 in §11 and it changes the scope by an order of magnitude.** A single-tenant
operator-configured LDAP sync is an M, not an XL. A multi-tenant one is the XL the roadmap
guessed at. We should not build the second while believing we're asked for the first.

---

## 4. Bind vs sync: SYNC ONLY, and the reason is that we have never touched a password

These are different products:

| | Per-login **bind** | Periodic **sync** |
| --- | --- | --- |
| What it is | user types a password, we bind to the directory as them | we read users/groups on a schedule and reconcile `Membership` + `GroupMember` |
| Failure mode | **directory unreachable ⇒ nobody logs in** | **directory unreachable ⇒ membership goes stale** |
| Latency of revocation | immediate | one sync interval |

**Naary handles no user password today, anywhere.** Firebase owns interactive sign-in and the
API only ever *verifies* an ID token (`apps/api/src/auth/firebase-verifier.ts`); SAML redirects
to the IdP. A grep for `password` across `apps/api/src` returns two hits, both of which
*reject* URL-embedded credentials (`mcp-registry/registry-sanitize.ts:97,126`). A per-login bind
would introduce plaintext password handling into the control plane for the first time — a new
class of secret in request bodies, logs, spans, and error paths — and it would make an external
network dependency a hard prerequisite for logging in, in a product whose whole pitch is
surviving outages.

**Decision: sync only.** Authentication stays Firebase or SAML. The directory is an
*authorization/lifecycle* source, never an authentication one. This also preserves the SAML
posture that an external identity provider is not an authorization source (`sso.service.ts:294`
— the role comes from the connection, never from an assertion attribute); a directory sync
changes that deliberately and only for **group membership**, never for `Membership.role`.

---

## 5. The trust question — LDAP's equivalent of the SAML domain claim

SAML's is stated in `SAML-SSO.md §"THE SECURITY INVARIANT"`: registering an IdP declares "this
certificate may assert these email domains", nothing in an HTTP request proves the registrant
owns them, so registration is operator-gated (`SSO_SELF_SERVICE` defaults off — `config.ts:139`
— and the default path is the CLI at `apps/api/src/sso/register-sso-connection.ts:13-16`).

The directory equivalent, stated the same way:

> Registering a directory connection declares **"this directory's `mail` attribute may create
> and remove memberships in this workspace."** Every user and group the sync ingests is scoped
> to `connection.tenantId`, and every ingested email's domain must be in that connection's
> non-empty `allowedEmailDomains`.

It is strictly **worse** than SAML's, for two reasons that must be written down:

1. **A sync writes without a user present.** A SAML assertion at least corresponds to a human
   completing a login. A sync creates `Membership` rows for people who have never visited, so a
   mis-scoped connection provisions silently and in bulk.
2. **It also *deletes*.** De-provisioning is the point, which makes a hostile or buggy
   connection a denial-of-service against a workspace's own members.

Consequences, mirroring SAML exactly: `allowedEmailDomains` required non-empty; all lookups
`(tenantId, email)` via `MembershipService.findByEmail`, whose doc comment already forbids an
email-only variant (`membership.service.ts:39-49`); registration operator-gated behind a
`DIRECTORY_SELF_SERVICE`-style flag defaulting off.

**The same residual applies, and is worse here.** `CompanyService.addMember` resolves an email
to a `userId` across the **entire instance** — `membership.findFirst({ where: { email }, orderBy:
{ createdAt: "desc" } })` (`apps/api/src/companies/company.service.ts:507-511`) — so a row
written by a directory sync, being newest, wins. SAML-SSO.md:136-144 records this as contained
by operator-gated registration; a bulk sync makes "newest row wins" far easier to hit by
accident. Making that lookup company-scoped should be a **prerequisite**, not a follow-up, if
this ships.

---

## 6. Credentials (Tier-1 §4)

**Preferred outcome: we hold none.** §3.1 (SCIM) and §3.2 (customer-run connector) both keep the
bind credential outside our systems entirely. That is the strongest available answer to
"where does the bind password live and how is it rotated", and it is a reason to prefer them
beyond connectivity.

If a build nonetheless holds one (the §3.3 self-hosted case, or a customer-exposed LDAPS
endpoint), the existing machinery is sufficient and no new storage is needed:

- Store it in `SecretStore` under a new key prefix beside `conn:`, `secret:`, `turnstile:`,
  `saml:` — e.g. `dir:<connectionId>:bind`. Rows land in `TenantCredential`, encrypted with the
  per-tenant DEK (`keyVersion 3`, `packages/secrets/src/tenant-keys.ts`), AAD `(tenantId, key)`.
- **Rotation** is already solved twice over: overwrite via `put` for a routine credential
  change; master-key rotation is `packages/secrets/src/rotate.ts` + `OLD_ENCRYPTION_KEY`;
  deleting the tenant's `TenantKey` row crypto-shreds it.
- **Read it in the sync activity only** — never return it from a service, never log it, never
  attach it to a span. If the sync runs API-side rather than in a Temporal activity, the
  precedent is `apps/api/src/turnstile/turnstile-config.service.ts:168`, with the two caveats
  that file demonstrates: build `SecretStore` **lazily** (constructing it reads
  `ENCRYPTION_KEY` — `sso.service.ts:97-99`), and get the env id via
  `getDefaultEnvironmentId(tenantId)` when there is no run context (`sso.service.ts:233`).
- Transport: **LDAPS or StartTLS, certificate validation on, no opt-out.** A plaintext bind
  ships the password over the wire; there is no configuration in which we should allow it.

---

## 7. Group → RBAC mapping, revocation timing, and in-flight approvals

An LDAP/SCIM group maps to a `PermissionGroup` row — not to `Membership.role`. Roles stay
locally administered (same reason as `sso.service.ts:294`); groups are the thing a directory
legitimately owns.

**What a sync must write, and what it must not.** `GroupsService.addMember` refuses a user with
no `Membership` in the group's tenant (`groups.service.ts:190-197`), so a sync creates the
membership first, then the group rows — the same order the invitation path uses. It must call
`PermissionsService.invalidateTenant` on every membership change, exactly as
`groups.service.ts:203,215` already do.

**How fast does removal take effect?** Two caches, both in-memory:

| Cache | TTL | Invalidated by |
| --- | --- | --- |
| effective grants + the "is this tenant enforced" cliff (`permissions-cache.ts:46`) | **30 s** | `invalidateTenant` on group/grant writes |
| memberships + role (`membership-cache.ts:31`) | **60 s** | `MembershipService.invalidate(userId)` |

`permissions-cache.ts:16` says it plainly: *"In-memory today (single API instance); a Redis impl
slots in behind the same interface."* So on the writing instance revocation is immediate; on any
**other** API instance it is up to the TTL, because there is no cross-instance invalidation
channel. That is acceptable for a sync (which is minutes-granular anyway) and is worth stating
rather than implying "immediate".

**Three real gaps a directory sync would inherit, found while writing this.** These are
pre-existing bugs in the manual removal path, not new ones — but a sync turns them from
occasional to routine, so they are prerequisites:

1. **`MembersService.removeMember` does not delete `GroupMember` rows.**
   `members.service.ts:234-235` is `membership.deleteMany` + `memberships.invalidate` and
   nothing else; the only `groupMember.deleteMany` in the API is `groups.service.ts:214`, and
   the schema has no FK from `GroupMember` to `Membership` (the constraint is a comment —
   `schema.prisma:806`). Not a live bypass (the guard fails closed with no `Membership` —
   `auth.guard.ts:343-345`), but it means a **re-added user silently regains their old grants**,
   and `GroupsService.list` shows ghost members (`groups.service.ts:94-106` returns raw
   `GroupMember` rows with no `Membership` join). A sync that removes and re-adds people
   routinely makes both certainties.
2. **`MembersService` never calls `permissions.invalidateTenant`** — it has no
   `PermissionsService` handle at all (`members.service.ts:67-70`), so a removed user's cached
   `EffectiveGrant[]` survives its 30 s TTL.
3. **In-flight approvals are a frozen snapshot.** The approver list is written into
   `ctx.__approval` when the run pauses (`apps/worker/src/temporal/workflow/engine/node-exec.ts:771-789`)
   and is never re-read. Decide-time enforcement re-checks against the live DB
   (`apps/api/src/executions/executions.access.ts:112-173`, group match at `:158-166`), so a
   de-provisioned user cannot approve — the guard denies them a session first. The approval is
   therefore **stranded**, not exploitable: with `timeoutHours` set it auto-**rejects**
   (`node-exec.ts:947-952`); without it, the run waits **forever** (`node-exec.ts:891,936`).
   Escape hatches are an owner/admin decision (`executions.access.ts:132-134`) or the HMAC
   signed link (`ExecutionsService.decideByToken`), which is membership-independent.

**Position:** de-provisioning is *next sync*, not immediate, and there is no immediate-revocation
path in a v1 — because the thing that makes revocation immediate (a login-time directory check)
is exactly the per-login bind §4 rejects. Instance-wide immediate revocation is
`SSO_SESSION_SECRET` rotation or a `Membership` delete, both already available to an operator.
Stranded approvals are surfaced, not auto-resolved: a sync that removes a user who holds a
pending approval should **warn** in the sync report and leave the run parked, because
auto-rejecting someone's compliance gate as a side effect of an HR system change is a worse
default than a stuck run.

---

## 8. Scheduling: we have no cron, and that is an argument

There is **no** `@nestjs/schedule`, no `ScheduleModule`, no `@Cron` anywhere in the repo. All
storage hygiene is opportunistic and inline on a request path — the SAML replay prune
(`sso.service.ts:247`), the OAuth state sweeps (`packages/connections/src/oauth.ts:513`), the
webhook dedupe prune (`webhook.service.ts:302`). `apps/api/src/heal/heal-workflow.ts:11` states the house position:
*"a cron sweeping a status column would be the wrong tool."*

Scheduling in this product is **Temporal Schedules** (`apps/api/src/schedules/schedules.service.ts`
— four `client.schedule.create` sites) plus exactly two non-workflow periodic things: the worker
heartbeat `setInterval` (`apps/worker/src/worker-heartbeat.ts:73`) and a boot-once reconcile
(`schedule-reconcile.service.ts:23`, `OnApplicationBootstrap`).

So a pull-based sync would need a **new** system-owned Temporal Schedule per connection, in a
namespace beside `sched-`/`poll-`/`cron-`, plus the operational surface that goes with it
(what happens on failure, backoff, is a run visible to the tenant, does it show up in the runs
list). A push model needs none of that. This is a smaller argument than §2 but it points the
same way.

---

## 9. If we build it anyway: the minimum shape

Sketched for completeness; **not** proposed for this slice.

```prisma
model DirectoryConnection {
  id                  String   @id @default(uuid())
  tenantId            String
  slug                String   @unique
  kind                String   // 'scim' | 'ldap'
  allowedEmailDomains String[] // REQUIRED non-empty — the §5 invariant
  // ldap only; null for scim (we hold no credential in the push model)
  url                 String?  // ldaps:// only
  bindDn              String?  // the PASSWORD lives in SecretStore under `dir:<id>:bind`
  userBaseDn          String?
  groupBaseDn         String?
  // group DN/name → PermissionGroup.id. Roles are NEVER directory-sourced.
  groupMap            Json?
  syncEnabled         Boolean  @default(true)
  enabled             Boolean  @default(true)  // kill switch, as SsoConnection has
  lastSyncAt          DateTime?
  @@index([tenantId])
}
```

Registration follows SAML's shape exactly: an operator CLI as the default path (the sibling of
`register-sso-connection.ts`), a `PUT` gated behind a self-service flag defaulting off, and
reads/deletes at owner/admin. Config accessors go in `apps/api/src/config.ts` next to the five
`SSO_*` ones (`config.ts:139-165`), each documented with its default and failure direction;
nothing new belongs in `env.ts`'s `requireEnv`, which hard-fails on `ENCRYPTION_KEY` and
`DATABASE_URL` only.

---

## 10. Testability — ending "not testable yet"

The SAML doc's "no live IdP round trip was performed" is a real limitation
(`SAML-SSO.md:282-286`). A directory does not have to inherit it, because unlike an IdP a
directory is a **container**.

- **Integration (the primary gate).** `bitnami/openldap` (or `osixia/openldap`) via
  testcontainers, seeded from a checked-in LDIF: two orgs, overlapping emails across them, a
  user in two groups, a user removed between runs. This slots into the existing harness with no
  new machinery — `vitest.integration.config.ts` (`apps/**/test/**/*.integration.spec.ts`,
  180 s timeouts, `fileParallelism: false` because containers bind host ports), run by
  `pnpm test:integration` and excluded from `pnpm test`. `@testcontainers/postgresql` is already
  a dependency (`apps/worker/package.json:48`); an LDAP module is the same pattern as
  `sql-node.integration.spec.ts:36`.
- **The SSRF seam.** A container publishes on `127.0.0.1`, which `isBlockedIp` rejects by
  design. Relax it exactly the way the SQL integration tests do — override the injected
  resolver on the deps object (`sql-node.integration.spec.ts:48`), never a product flag. **A
  test that needs a production relaxation switch is telling you the design is wrong**; this one
  doesn't.
- **What to actually assert** (the SAML testing section's spirit — the rejections are the
  interesting part): a user whose email domain is not in `allowedEmailDomains` is refused;
  ingest for tenant A cannot touch tenant B's `Membership`; a removed user loses `GroupMember`
  *and* the tenant's permission cache is invalidated; a removed user holding a pending approval
  produces a warning and leaves the run parked; a `ldap://` (non-TLS) URL is refused; the bind
  password never appears in a log line, a returned DTO, or a span (assert on the serialized
  payload, the way `sso-session.service.spec.ts` asserts the token body carries no secret).
- **E2E** is the wrong layer for this. `docker-compose.e2e.yml` is a browser-Playwright overlay
  (ephemeral `127.0.0.1::<port>` binds, `container_name: !reset null`, a per-run project id at
  `.github/workflows/e2e.yml:101`); adding a service there costs the whole namespacing dance for
  a feature with almost no UI. Add an e2e service only when there is a connection-management
  screen to click.

A `docs/directory-testing.md` (the sibling of `sso-testing.md`) is worth writing **when
something ships**, not before — writing it now would repeat the mistake this doc is fixing.

---

## 11. Decisions (need a one-sentence answer each)

1. **Is there a real customer, and is their directory already fronted by an IdP?** If it is
   Entra/Okta/Google/ADFS, the shipped SAML path plus SCIM covers it and LDAP should be closed
   as won't-do — this is the single question that decides whether §3.2 exists at all.
2. **Self-hosted or SaaS for those tenants?** Self-hosted (§3.3) is an operator-env-var sync,
   roughly M. SaaS is the multi-tenant XL. We should not build the second believing we were
   asked for the first.
3. **Confirm sync-only** — the directory is an authorization/lifecycle source, never an
   authentication one, and Naary continues to never handle a user password (§4).
4. **De-provisioning at next sync is acceptable?** i.e. no immediate-revocation path in v1, with
   the 30 s/60 s cache TTLs (§7) as the extra tail on multi-instance deployments.
5. **A sync that de-provisions a user holding a pending approval should warn and leave the run
   parked** — rather than auto-rejecting it or reassigning it. Confirm, because the alternative
   (auto-reject) silently fails compliance gates on an HR change.

If (1) is "no identified customer", the recommendation is to **close the LDAP half of the
roadmap line as won't-do** and re-file SCIM as its own S–M item. The evidence for that is the
market position in `sso-testing.md:177-179`, not a preference.

---

## 12. Deferred / explicitly not in scope

- **Per-login bind authentication** (§4) — and with it, any handling of a user password.
- **Directory-sourced `Membership.role`.** Groups only; roles stay locally administered.
- Nested-group flattening, `memberOf` vs `member` reconciliation, referral chasing, paged
  results beyond a first page, and AD-specific attribute dialects — all real LDAP work, all
  moot until decision 1 lands.
- **Immediate revocation** (a login-time directory check), and cross-instance cache
  invalidation (the Redis `PermissionsCache` that `permissions-cache.ts:16` anticipates).
- **Fixing the three §7 gaps.** They are pre-existing defects in the manual removal path and
  deserve their own issue whether or not any of this ships.
- **Company-scoping `CompanyService.addMember`'s instance-wide email lookup** (§5) — already a
  known residual from SAML; a prerequisite if a sync ships, but it belongs to the Companies
  work.
- A `docs/directory-testing.md` runbook, and any SPA screen for managing a connection.
