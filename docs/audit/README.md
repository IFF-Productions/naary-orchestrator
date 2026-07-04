# Audit — naary-orchestrator (2026-07-04)

A combined **security + QA + architecture** audit of the repo, run as a read-only
source review on branch `docs/webhooks` (HEAD `9296ed8`). Every finding was
confirmed against actual code; areas not reviewed are called out explicitly so
there is no implied all-clear.

## Reports

| Report | Scope |
|--------|-------|
| [SECURITY-AUDIT-2026-07-04.md](./SECURITY-AUDIT-2026-07-04.md) | Secrets, multi-tenancy, authN/authZ, SSRF/injection, crypto, infra/CI |
| [QA-AUDIT-2026-07-04.md](./QA-AUDIT-2026-07-04.md) | Test-suite run, coverage map, correctness edge-cases, CI gating |
| [ARCHITECTURE-AUDIT-2026-07-04.md](./ARCHITECTURE-AUDIT-2026-07-04.md) | CLAUDE.md TIER 1 compliance, durability/scale, module boundaries, extensibility |

These supersede the pre-hardening `docs/SECURITY-REVIEW.md`, `docs/QA-FINDINGS.md`,
and `docs/ARCHITECTURE-REVIEW.md` (dated 2026-06-27), which were written when the
API had **no authentication at all**. Most of their findings are now fixed — each
report has a "verified fixed" section citing the current code.

## Overall assessment

**The codebase is in materially better shape than the prior review docs suggest.**
The pre-hardening reviews' headline items — no auth, no input validation, no
CORS/rate-limiting, plaintext webhook secrets, no exception filter — are all fixed
and verified. Multi-tenant isolation is enforced two independent ways and I found
**no IDOR**. The TIER 1 architectural contract (interpreter-not-codegen,
deterministic workflow code, secrets-never-in-Temporal, human-approval-via-signal,
billing-fails-safe) holds throughout. The test suite is broad and green
(**337 passed / 2 skipped**, build + typecheck clean).

The residual risk that remains is concentrated and specific.

## What to fix first

1. **HTTP/RSS egress — redirect-follow SSRF bypass** (Security S-1, **High**).
   `fetch` follows redirects with no per-hop re-check, so a public URL can redirect
   into cloud-metadata / internal endpoints and the response returns into the run.
   *Fix once with a connect-time-validating undici dispatcher + `redirect: 'manual'`
   — the same fix closes the DNS-rebind TOCTOU (S-2).*

2. **SQL DSN is not egress-guarded** (Security S-3, **Medium**). The one outbound
   connector missing an `assertHostPublic` check; lets a tenant reach internal DBs /
   port-scan the internal network. One-line fix mirroring the sendEmail node.

3. **Verify interpreter control-flow coverage** (QA Q-1, **Medium**). The durable
   differentiators — merge fan-in, `forEach`/sub-workflow fan-out, `humanApproval`
   timeout, `continueAsNew` — need their interpreter-level e2e assertions confirmed
   (or added). A regression here fails *silently as a completed run*.

## Then

- Webhook ingress does pre-auth DB+decrypt work (S-4, Low; throttler mitigates).
- Abandoned OAuth-state rows are never swept (S-5, Low).
- `forEach` cost-cap overshoot + up-to-100 concurrent children (Q-3 / A-3).
- Node-type definitions duplicated across ~5 files — refactor to a registry
  **before** the next big node push (A-1).
- Re-verify `runAgent` billing edge-cases + usage aggregation (Q-5).
- Confirm Prisma indexes on the hot read paths (A-4).
- Track the deferred single-master-key → KMS/per-tenant-DEK item (S-6).

## Not covered this pass

Dependency CVE/SCA scan; web XSS surface + nginx CSP; MCP client internals; the
SecretStore backend; and the Firebase tenant-claim **provisioning** path (a loose
claim-setter would let a user self-assign a tenant and would outrank everything
above — worth a dedicated look).
