# Invoking a workflow by webhook

A workflow whose entry node is a **Webhook** trigger runs when a signed HTTP `POST`
arrives at its ingress URL. Requests are authenticated by an **HMAC-SHA256 signature over
the raw request body** (the GitHub `X-Hub-Signature-256: sha256=<hex>` scheme) — there is no
bearer token on the ingress. This doc shows how to register an endpoint and invoke it.

- **Ingress:** `POST /hooks/:endpointId` — public, signature-authenticated.
- **Body:** any JSON. It becomes the webhook-trigger node's output (i.e. the run's input).
- **Base URL:** the API service. Examples below use the local dev stack, `http://localhost:3000`.

---

## 1. Register an endpoint (once)

Registration mints a **signing secret** (shown exactly once) and a stable ingress path. Do it
in the UI (**Integrations → add a webhook**) or via the API with your tenant `nry_` token:

```bash
API=http://localhost:3000
TOKEN='nry_...'            # your tenant API token
TENANT='t-demo'           # your tenant id

curl -sS -X POST "$API/tenants/$TENANT/webhooks" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{ "workflowId": "my-workflow-key", "provider": "generic" }'
```

Response (the `signingSecret` is returned **only** here — store it):

```json
{
  "endpointId": "b1c2...",
  "ingressPath": "/hooks/b1c2...",
  "signingSecret": "9f8e...<64 hex chars>"
}
```

- `workflowId` is the **workflowKey** of a saved graph whose entry node is a Webhook trigger.
- `provider` is one of `generic` | `github` | `atlassian` — it only selects which header carries
  the **delivery id** used for de-duplication (see below). Use `generic` for your own callers.

---

## 2. Invoke the webhook

Compute `sha256=<hmac>` over the **exact bytes** you send, and pass it as `X-Hub-Signature-256`.

```bash
API=http://localhost:3000
ENDPOINT='b1c2...'                 # endpointId from step 1
SECRET='9f8e...'                   # signingSecret from step 1
BODY='{"hello":"world","order":42}'

# HMAC-SHA256 of the raw body, hex — MUST match the bytes sent verbatim.
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)"

curl -sS -X POST "$API/hooks/$ENDPOINT" \
  -H "content-type: application/json" \
  -H "X-Hub-Signature-256: $SIG" \
  -H "x-delivery-id: $(uuidgen)" \
  --data-binary "$BODY"
```

Response (`202 Accepted`) — fire-and-forget; the run continues in the background:

```json
{ "status": "started", "workflowId": "wh-t-demo-9c3f..." }
```

> **Sign the exact bytes.** The signature is verified against the raw request body, not the
> re-serialized JSON. Build `BODY` once and send it with `--data-binary` (and `printf '%s'`,
> which adds no trailing newline) so the signed bytes and the sent bytes are identical. A
> mismatch → `401 Invalid signature`.

### The delivery-id header (de-duplication)

An optional per-delivery id makes retries idempotent — a repeat with the same id is ignored
(`{ "status": "duplicate_ignored" }`, still `2xx` so the caller stops retrying). The header name
depends on the `provider` you registered:

| provider    | delivery-id header                 |
|-------------|------------------------------------|
| `generic`   | `x-delivery-id`                    |
| `github`    | `x-github-delivery`                |
| `atlassian` | `x-atlassian-webhook-identifier`   |

Omit it and every request is processed (no de-dup).

---

## 3. Getting a synchronous response

By default the ingress replies `202 { status: "started" }` immediately. If the graph contains a
**Respond to Webhook** node, the ingress instead **waits (bounded, ~10s)** for that node to run
and returns its response — status code, headers, and body — to your caller. See the
`respondToWebhook` node. If the run never reaches that node in time, it falls back to `202`.

## Responses at a glance

| HTTP | body | meaning |
|------|------|---------|
| `202` | `{ status: "started", workflowId }` | accepted; run started (fire-and-forget) |
| `2xx` | `{ status: "duplicate_ignored" }` | same delivery id already seen |
| _node-defined_ | _node-defined_ | a `respondToWebhook` node produced a synchronous response |
| `401` | — | signature missing/invalid (HMAC mismatch) |
| `404` | — | unknown endpoint, or no graph saved for its workflowKey |

## Security notes

- The signing secret is stored **encrypted at rest** (AAD-bound to the tenant) and returned in
  plaintext only at registration — treat it like a password; rotate by re-registering.
- The signature covers the raw body only. Put nothing sensitive in the URL; there is no other
  auth on the ingress.
- Payloads should be small (Temporal ~2MB cap). Large inputs belong in object storage — pass a
  reference, not the blob.
