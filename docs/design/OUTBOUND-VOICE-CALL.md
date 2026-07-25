# Design: `voiceCall` node — place an outbound call, play generated audio, resume on the outcome

**Status:** proposed · **Date:** 2026-07-25 · **Recommendation: CONDITIONAL NO-GO** (see §9) ·
**Why a doc:** the feature needs a *new public-internet primitive* (an unauthenticated audio URL
that Twilio's media servers can fetch) and carries direct legal exposure for the tenant. Both are
one-way doors — the URL scheme becomes an external contract, and a compliance posture bolted on
after launch is a posture nobody enforces. Ref #690, depends on #689 (`textToSpeech`).

---

## 0. Summary

Place an outbound call that plays a `textToSpeech` clip to a customer, park the run durably, and
resume on Twilio's status callback with a branchable outcome
(`completed | no-answer | busy | failed | voicemail`).

The durable-wait half is **essentially free** — the machinery exists and was hardened for exactly
this shape two PRs ago (§4). The blocking work is elsewhere: the audio has no public URL, the
integration transport cannot speak Twilio's wire format, per-minute spend has no pre-flight guard,
and the compliance surface is larger than the feature. §9 recommends **not building the slice yet**
and names the four concrete changes that flip it to go.

---

## 1. Where we actually are (the issue's premise is wrong, in a more interesting way)

#690 says "Twilio in our catalog is SMS-only." That is **not** what the code says.
`packages/dsl/src/integrations.ts:2645-2680` already ships a `make_call` action:

```ts
{
  key: "make_call",
  label: "Make call",
  description: "Place an outbound phone call.",
  method: "POST",
  pathTemplate: "/Accounts/{accountSid}/Calls.json",
  write: true,
  fields: [ accountSid (path), To (body), From (body), Url (body, "TwiML URL …") ],
}
```

So `Calls.json` + a TwiML URL field are already in the catalog. **They have never worked.** The
integration activity hard-codes a JSON body:

```ts
// apps/worker/src/temporal/activities/integration.ts:154-158
const init: RequestInit = { method: req.method, headers };
if (req.method !== "GET" && req.body !== undefined) {
  init.body = JSON.stringify(req.body);
  headers["Content-Type"] = "application/json";
}
```

Twilio's REST API accepts **`application/x-www-form-urlencoded` only** for POST bodies. It will
reject that request. Nothing caught it because no Twilio *write* has ever been exercised:
`docs/integrations/VERIFICATION.md:135` records `| twilio | list_messages | accountSid | 2/4 | — |`
— 2 of 4 actions covered, both reads, live-coverage column empty.

`docs/design/INTEGRATION-NODES.md:189-193` already names this as a known catalog gap, and is
explicit that a provider needing form-encoding **must not** be added with a "close enough"
`authScheme` because it would silently fail to authenticate. `make_call` and `send_sms` are both
sitting in that trap today.

> **Finding worth its own issue regardless of whether we build voice:** `twilio.send_sms` and
> `twilio.make_call` are broken in the shipped catalog. Either add `bodyEncoding: "json" | "form"`
> to `IntegrationAction` (a data-shaped change that fixes both), or remove the two write actions
> so authors can't place a node that cannot succeed. This is a bug fix, not part of this design.

### What #699 shipped, and what it means here

`textToSpeech` writes audio to object storage and returns **only a reference**
(`packages/dsl/src/node-output.ts:92-108`):

```ts
audio: { __objectRef: string; contentType: string; bytes: number }
```

`__objectRef` is deliberately **not** the `{ __claimCheck, bytes }` shape, and the reason is
load-bearing for us: the API's run-detail read resolves *every* claim check in the run ctx on
*every* read (`executions.queries.ts` → `resolveCtxRefs` → `resolveClaimChecks`, which fetches the
object and `JSON.parse`s it). Run detail polls, so a claim-checked audio blob would be re-fetched
and re-inlined as base64 into every poll response. `isClaimCheck` only tests for `__claimCheck`, so
`__objectRef` flows through untouched and the API streams the bytes from a dedicated route instead.

**Consequence for this design:** the call node receives an `__objectRef` (e.g.
`s3://bucket/tts/<tenantId>/<executionId>/<nodeId>.mp3`), which is an *internal* address. There is
no code path today that turns it into something Twilio can fetch. That is §2.

---

## 2. The centre of this design — a public audio URL

Twilio's `<Play>` verb makes Twilio's own media servers issue an **unauthenticated GET from IPs we
do not control**, and Twilio may **re-fetch on retry or on a second `<Play>`**. So:

- An allowlist is not the guard. Short TTL + HMAC + a key shape that cannot be walked to another
  tenant's object is the guard.
- The token must be **multi-use within its TTL**. A one-shot token makes `<Play>` fail
  intermittently, which is the worst possible failure mode (a customer hears silence, we bill a
  minute, the outcome says `completed`).

`ObjectStore` cannot help. The whole interface is two methods
(`packages/storage/src/object-store.ts`):

```ts
export interface ObjectStore {
  put(key: string, data: Buffer | string): Promise<string>;
  get(ref: string): Promise<Buffer>;
}
```

No `signedUrl`, no `delete`, no TTL/lifecycle, and two implementations (`MemoryObjectStore`,
`S3ObjectStore`) — memory being the dev/test default, which lives *in the process*, so a
worker-written object isn't even readable from the API process locally.

### Option A — `ObjectStore.signedUrl(ref, ttl)` (S3 presign)

**For:** the TTL and the unguessability are enforced by the storage provider; no new public route;
nothing of ours is in the request path, so a media-server retry storm costs us nothing.

**Against:** it punches a hole in the cloud-portability seam the interface exists to protect —
`MemoryObjectStore` has no URL to give, so dev/test would need a local signing shim, and the
not-yet-written GCS implementation would need its own. It also exposes the bucket/host directly,
and S3 presigned GETs are awkward to revoke before expiry.

### Option B — a public HMAC-signed audio route (recommended)

Reuse the machinery we already have. `apps/api/src/executions/resume-token.ts` is the pattern: HMAC
over an id with the boot-required `ENCRYPTION_KEY`, domain-separated by a prefix, constant-time
compare, and *the URL is the credential*:

```ts
export function mintResumeToken(workflowId: string): string {
  return createHmac("sha256", signingKey()).update(`resume:${workflowId}`).digest("hex");
}
```

Serve at `GET /pa/:executionId/:nodeId?exp=<unix>&sig=<hmac>` (`pa` = public audio), `@Public()`,
alongside the `/f/:id` and `/c/:id` precedent.

Three properties it must have, each learned from an existing file:

1. **The object reference comes from the run ctx, never the request.** This is already the stated
   rule for the authenticated artifact route (`apps/api/src/executions/run-artifacts.ts`): taking a
   client-supplied ref would be an arbitrary cross-tenant object read. And it is not sufficient on
   its own — a graph author can put *any* `__objectRef` into ctx via a `set` node, so the resolved
   reference must additionally be required to sit under this tenant's own `tts/<tenantId>/` prefix.
   That check already exists; reuse it verbatim.
2. **Content-type allowlist.** Same file: an arbitrary stored `contentType` reaching a browser
   response header turns an object read into a stored-XSS sink. Audio MIME types only, plus
   `x-content-type-options: nosniff`.
3. **Signed expiry.** Unlike the resume token, `exp` must be *in* the signed message — the approval
   token (`apps/api/src/executions/approval-token.ts`) already does this. Propose **15 minutes**:
   longer than any call setup + playback, shorter than the URL's useful life in Twilio's request
   logs (where it *will* be retained).

**Decision: Option B.** It keeps `ObjectStore` provider-agnostic, works identically on memory and
S3, is revocable (the run's ctx is the authority), and reuses three pieces of already-reviewed
security code instead of introducing a presigning path per provider.

> **Scope fence:** this route is for TTS audio referenced by a *live* run. It is not a general
> public-object CDN, and it must not accept a bare object key.

Twilio also needs **TwiML**, not just audio — `Url` returns a document. Serve it from the same
signed family (`GET /pa/:executionId/:nodeId/twiml`) returning
`<Response><Play>…/pa/…</Play></Response>`, so one signature covers both fetches. Both routes need
`@Throttle` — note that neither the resume ingress (`hooks.controller.ts:49`) nor the public
approval route has one today, so this is a small hardening precedent to set rather than copy.

---

## 3. Node shape

A **dedicated `voiceCall` node type**, not a catalog action. `INTEGRATION-NODES.md:7-33` sets the
house default in the other direction ("one node + catalog, NOT N node types"), so this needs a
rebuttal, and it is the same one #689 used for `textToSpeech` (`packages/dsl/src/types/ai.ts:15-45`):
the declarative catalog is JSON-request → JSON-response and cannot express this call. Two additional
reasons that TTS did not have:

- **The catalog has no durable lifecycle.** A catalog action is one request/response. This node
  places a call, then *parks the workflow* until a callback arrives. That is interpreter behaviour,
  not a table row.
- **Retry semantics are inverted.** Catalog `write: true` gives at-most-once, which is right — but
  this node must ALSO record usage after the outcome, and must never re-place a call.

```ts
export interface VoiceCallNodeConfig {
  provider?: "twilio";
  connectionId: string;          // resolved in-activity; never the credential itself
  accountSid: string;
  from: string;                  // E.164, must be a number on the tenant's account
  to?: string;
  toBinding?: ArgBinding;
  /** The textToSpeech node whose `audio.__objectRef` is played. */
  audioBinding: ArgBinding;
  /** Prepended AI-voice disclosure. Default ON; see §6. */
  disclosure?: { enabled?: boolean; text?: string };
  timeoutSeconds?: number;       // ring timeout handed to Twilio
  /** Durable wait cap; on expiry the node emits timedOut and the graph branches. */
  waitTimeoutSeconds?: number;
  /** Tenant's written attestation that it has consent to call this number. Required. */
  consentAttested: true;
  maxMinutes?: number;           // hard spend ceiling, see §5
  costUsd?: number;              // never-zero fallback
}
```

Output, per the issue:

```ts
{ status: "completed" | "no-answer" | "busy" | "failed" | "voicemail",
  durationSeconds: number, callSid: string, answeredBy?: string }
```

Registration touch points are the #699 checklist verbatim (DSL union + interface + zod schema +
`Exact<>` proof + coverage map + catalog entry; worker activity + `proxies.ts` policy +
`node-handlers/index.ts`; web palette tile + config panel + `ERRORABLE_KINDS`). Two deltas:

- `proxies.ts` must use **`maximumAttempts: 1`** (the `callSendEmail` / `callSqlExec` precedent).
  `textToSpeech` uses 3 because synthesis is idempotent; placing a call is not — a retry dials a
  human twice.
- **Not** in `RETRYABLE_KINDS` (`screens/canvas/fields.tsx:145-153` already excludes the
  at-most-once nodes for this reason). In `ERRORABLE_KINDS`, yes.
- Simple mode: **skip**, following #699's precedent (`textToSpeech` is builder-only,
  `friendly-catalog.ts` has no entry). A non-developer surface is the wrong place to hand someone a
  robocall button.

---

## 4. Durable wait — reuse, and it is already hardened

No new mechanism. `wait(mode: "webhook")` is the shape
(`apps/worker/src/temporal/workflow/engine/node-exec.ts:417-455`):

```ts
state.status = "awaiting_webhook";
await syncStatus();
let resumed = true;
if (timeoutMs !== undefined) {
  resumed = await wf.condition(() => state.webhookResume !== undefined, timeoutMs);
} else {
  await wf.condition(() => state.webhookResume !== undefined);
}
ctx[node.id] = { resumed, timedOut: !resumed, payload: … };
state.webhookResume = undefined; // consume
```

Signal + `condition()` — Tier-1 rule 5, no polling, survives worker restarts and days of waiting.
Twilio's status callback POSTs the existing resume ingress (`hooks.controller.ts:43-62`, `@Public()`,
HMAC token, 202/409).

**#698/#681 matters here and should be called out as the reason this is now safe.** Before it, an
un-consumed resume Signal *blocked* `continueAsNew`, so a long-parked run risked either dropping the
signal or growing history unboundedly. Signals are now **carried across the boundary**
(`engine/exec-chain.ts:574-636`) and re-seeded on the other side (`run-graph.ts:136-145`):

```ts
...(state.webhookResume !== undefined ? { webhookResume: state.webhookResume } : {}),
```

with the ordering comment noting that `state.approval === undefined` must short-circuit before
`patched()` so ordinary histories stay byte-identical. `apps/worker/test/chaos-durability.e2e.spec.ts:358`
already proves the exact case — a `resumeSignal` pending across a CAN boundary. That test is the
template for the slice's proof.

**Two design choices the wait forces:**

- **Fold the wait into the node, or compose `voiceCall` → `wait(webhook)`?** Compose. The graph
  stays readable (the pause is visible as a node), no interpreter change is needed, and
  `timedOut` is already a branchable output. Folding it in (the `CLAUDE-CODE-NODE.md §8b.2` route)
  buys one less node at the cost of new `patched()`-gated interpreter code.
- **Signature verification.** Twilio signs its webhooks (`X-Twilio-Signature`, HMAC-SHA1 over the
  full URL + sorted POST params, keyed by the auth token). The resume ingress today verifies *our*
  token only. Since the auth token is a tenant credential that must be decrypted, this cannot
  happen in the generic hooks controller — it needs a call-specific ingress
  (`POST /hooks/voice/:workflowId/:nodeId`) that resolves the tenant, verifies Twilio's signature,
  and only then signals `resumeSignal`. **Without this, anyone holding the URL can forge a
  `completed` outcome.**

---

## 5. Billing and the spend guard

**There is no `unit`/`quantity` pair in the ledger.** `RecordUsageInput.usage` is token-shaped
(`inputTokens`/`outputTokens`/`totalTokens`). `textToSpeech` solved its per-character unit by
booking **one synthetic token per character** against a *separate provider key* `openai-tts`, whose
pricing table is read as USD per 1M **characters** (`packages/usage/src/pricing.ts:92-110`, which
states outright that migrating the ledger to unit+quantity was considered and rejected because it
would touch the schema and the insights rollups).

Follow it: provider key **`twilio-voice`**, priced per 1M **seconds**, `inputTokens = durationSeconds`.
Distinct key so mixed units never share a table — the footgun that comment warns about.

Two hard constraints:

- **`UsageEvent` is unique on `(executionId, nodeId)`** and the upsert's `update: {}` means
  first-write-wins (`packages/usage/src/usage.service.ts:80-92`). So metering **must happen once, at
  the callback**, when the real duration is known. A place-time write would silently swallow the
  real cost. Because the callback is a separate activity from the placement, this is naturally a
  single write — but if the design ever splits into reserve-then-commit, the ledger key is wrong for
  it and that must be re-opened, not worked around.
- **Nothing but the `agent` node reserves budget.** `reserveBudget` is called only from
  `activities/agent.ts`. `textToSpeech` records *after the fact*, which is tolerable because its
  input is capped at `MAX_TTS_INPUT_CHARS = 4096` — spend is bounded before the call is made. **A
  voice call has no such bound:** it is third-party-billed per minute and the *callee* controls
  duration. A loop over a contact list is an unbounded phone bill, and a "record afterwards" model
  discovers it after the money is gone.

  So the node needs a **pre-flight reservation** of `maxMinutes × rate` (defaulting `maxMinutes` to
  something small, e.g. 5) via the existing `reserveBudget` path, released/committed at the
  callback, plus `maxMinutes` handed to Twilio as a hard call time limit so the reservation is
  actually a ceiling and not a guess. This is genuinely new work — the first non-`agent` reservation
  call site — and it is the strongest technical argument for delaying the slice.

Egress: Twilio REST calls via `safeFetch` (`packages/connections/src/safe-fetch.ts`), which
re-validates every redirect hop and pins the checked IP.

---

## 6. Compliance — mandatory, and the reason for the recommendation

This section is not a footnote. An outbound automated-voice feature makes *our product* the
instrument of a call that can carry statutory penalties per call. The design must say, per
obligation, **who enforces it** — and "the tenant is responsible" is only honest if the product
doesn't make violating it the path of least resistance.

This is a design position, not legal advice; a real launch needs counsel sign-off on the enforced
set.

| Obligation | Posture | Mechanism |
|---|---|---|
| **Consent to call** (TCPA-style prior express consent for automated/prerecorded calls to mobiles; per-country robocall regimes) | **Tenant responsibility, product-attested** | `consentAttested: true` is a *required* config field — the graph will not save without it. The node's UI copy states the attestation in the first person so it is a deliberate act, not a checkbox someone skims. We cannot verify consent; we can refuse to let it be implicit. |
| **AI-voice / prerecorded disclosure** (tightening in several jurisdictions; a synthesized voice may be legally required to announce itself) | **Product-enforced by default** | `disclosure.enabled` defaults to **true** and prepends a spoken preamble before the tenant's audio. Turning it off is possible but is a visible, logged choice with a warning. Default-on is the whole point: the compliant path must be the lazy path. |
| **Quiet hours** (local-time calling windows) | **Product-enforced** | The activity resolves the callee's local time from the E.164 country/area code and refuses to place a call outside a configurable window (default 09:00–20:00 local), throwing a non-retryable `QUIET_HOURS` failure so the graph can branch and retry later rather than the run dying. Deliberately enforced rather than delegated: a workflow that fires on an inbound event has no natural sense of the callee's clock. |
| **Retry / call-frequency limits** | **Product-enforced** | `maximumAttempts: 1` on the activity means the *platform* never re-dials. A tenant re-calling deliberately (the "on voicemail, retry later" pattern the issue wants) is an explicit graph edge, and a per-`(tenantId, to)` attempt counter with a daily cap backstops a runaway loop. |
| **Do-not-call suppression** | **Product-enforced list, tenant-supplied contents** | A per-tenant DNC list, checked in-activity before dialling; a match is a non-retryable `DNC_SUPPRESSED` outcome. We host and enforce the list; we cannot populate it from national registries on the tenant's behalf. |
| **Call recording consent** (one-party vs all-party jurisdictions) | **Out of scope — recording is NOT built** | The node must not gain a `record: true` flag in this design. All-party-consent jurisdictions make silent recording a criminal matter, and the feature is not needed for the stated use case. If recording is ever added it needs its own design and its own consent gate. |
| **Caller ID accuracy** | **Product-enforced** | `from` must be a number verified on the tenant's own Twilio account; spoofing an arbitrary `from` is a separate offence in several regimes. Twilio enforces this at its API, and we surface the rejection rather than retrying it. |

### Proposed node UI copy (this is part of the deliverable)

> **Outbound voice call**
> Places a real phone call and plays your generated audio to the person who answers.
>
> ☑ **I confirm this number has given prior consent to receive automated calls from us.**
> Required. Automated and prerecorded calls are regulated (TCPA in the US, and equivalent
> robocall rules elsewhere); penalties are **per call** and land on you, not on Naary. We cannot
> verify consent — you are attesting to it.
>
> ☑ **Announce that this is an AI-generated voice** *(recommended, on by default)*
> Prepends: *"This is an automated message from {workspace}."* Several jurisdictions now require a
> synthesized voice to disclose itself. Turn this off only if you have checked the rules for every
> region you call.
>
> **Calling hours** 09:00–20:00 in the recipient's local time. Calls outside this window are not
> placed — the run branches to your "skipped" path so you can schedule a retry.
>
> **Spend limit** Max {maxMinutes} min per call. Voice is billed per minute by Twilio and reserved
> against your monthly cap before the call is placed.
>
> This node does **not** record the call.

---

## 7. Tier-1 / security alignment

- **§2/§3 (determinism, side effects in activities):** placing the call, resolving the audio ref,
  the DNC/quiet-hours checks and the ledger write are all activity work. The workflow only decides
  which node runs next and awaits a Signal.
- **§4 (secrets never in Temporal):** the Twilio `AccountSid:AuthToken` is resolved from the
  connection **inside** the activity by `connectionId`; `accountSid` in config is not a secret (the
  catalog already treats it as a plain path field). The auth token is also needed to verify the
  inbound callback signature — that happens in the API, by tenant lookup, and the token is never
  returned or logged.
- **§5 (durable wait):** Signal + `condition()`, never a poll.
- **§6 (billing fails safe):** `costUsd` fallback plus pricing against a real rate table if the
  reported duration is missing; never zero.
- **§7 (stateless workers):** the parked state is Temporal's; the audio is in object storage.
- **Payloads:** the audio never enters history — only the `__objectRef`. Note honestly that the
  resolved `to` number *does* appear in workflow arguments, exactly as `textToSpeech`'s resolved
  text does (`node-handlers/ai.ts:145-152` says so explicitly). A phone number is personal data, so
  this is a **privacy point to decide, not to gloss**: either accept it (consistent with existing
  prompt handling) or pass a reference. Recommend accepting it and documenting it, since the ledger
  itself still stores no PII.

---

## 8. Slices (if this becomes a go)

1. **Unblock the transport.** `bodyEncoding: "json" | "form"` on `IntegrationAction`; fix
   `integration.ts:154-158`. *Verify:* a live `twilio.send_sms` succeeds — the first live Twilio
   write ever, closing the `VERIFICATION.md:135` gap. Valuable on its own, independent of voice.
2. **Public signed audio + TwiML routes.** `@Public()`, HMAC with signed `exp`, ctx-sourced ref,
   tenant-prefix check, content-type allowlist, `@Throttle`. *Verify:* a signed URL streams the
   audio; a tampered `sig`, an expired `exp`, and a ref pointing at another tenant's prefix each
   401/403; `curl` from outside the VPC fetches it.
3. **Spend guard.** Extend `reserveBudget` to a second call site with `maxMinutes × rate`.
   *Verify:* a tenant at cap is refused before any call is placed.
4. **`voiceCall` node + compliance gates,** composed with `wait(webhook)`; Twilio-signature-verifying
   callback ingress. *Verify:* a real call plays #689's audio and the run resumes on the real status
   callback with a branchable outcome; a forged callback is rejected; quiet-hours and DNC each
   produce their branch; the chaos test proves the pending signal survives `continueAsNew`.

---

## 9. Recommendation: CONDITIONAL NO-GO

**Do not build the slice now.** Not because the durable wait is hard — that part is done and
hardened — but because the ratio is wrong: the feature is one activity plus a `wait` node, sitting
on top of **four missing primitives and seven compliance obligations**, three of which we would have
to enforce in product code that does not exist. Shipped early, the likely outcome is a working demo
with an unbounded phone bill, a forgeable outcome callback, and a tenant exposed to per-call
statutory penalties on a checkbox we never showed them.

The honest framing: this is not "an integration we're missing." It is a regulated-communications
feature wearing an integration's clothes.

**What flips it to go — all four, in order:**

1. `bodyEncoding` lands and a live Twilio write is verified green (slice 1). Until then the catalog
   is advertising two actions that cannot work, and voice would be the third.
2. The public signed-audio primitive is reviewed and merged as its own slice, with the
   tenant-prefix and content-type checks proven by test — not co-designed inside a node PR.
3. Pre-flight reservation works for a non-`agent` node, with a hard `maxMinutes` ceiling passed to
   the provider. This is the item most likely to be skipped under time pressure and the one whose
   absence is a direct financial risk.
4. Someone with authority accepts the §6 table as *product-enforced* — specifically default-on AI
   disclosure, quiet hours, and DNC. If the answer is "make those optional so it's easier to
   demo," the answer to the feature is no.

**Cheaper alternative that captures most of the value now:** the same "pause durably, resume on an
async outcome" story is already fully supported for **SMS** — which is the correct first step anyway
(cheaper, no per-minute bill, no voice-disclosure regime, no quiet-hours-by-the-second nuance, and a
delivery-status callback with the identical shape). Slice 1 alone makes `twilio.send_sms` work; a
`wait(webhook)` after it gives the durable-resume showcase the issue wants, with a fraction of the
exposure. **Recommend doing that, and revisiting voice once 1–4 are true.**

---

## 10. Open questions

- **Voicemail detection.** Twilio's `answeredBy` (AMD) is a paid add-on and is probabilistic.
  *Proposed:* expose it as optional and document it as best-effort; never let `voicemail` be
  inferred from duration heuristics, which would be a fabricated output.
- **Audio TTL vs. call duration.** A call queued behind Twilio's own concurrency limits could start
  after a 15-minute `exp`. *Proposed:* mint `exp` at *placement* with a 1-hour ceiling and hand
  Twilio a `timeLimit`, so the signature outlives the longest legitimate call but not the log
  retention window.
- **Object lifecycle.** `ObjectStore` has no `delete`, so TTS audio for a call persists
  indefinitely. *Proposed:* out of scope here, but it makes a bucket lifecycle policy a deployment
  requirement rather than a nice-to-have — worth its own issue.
- **Which `exp` clock.** The API mints, Twilio fetches. *Proposed:* server `Date.now()` in the API
  (an I/O zone, so no determinism concern) — never in workflow code.
