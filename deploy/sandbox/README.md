# codeAgent sandbox — egress isolation (Slice 2a)

The security boundary for the `codeAgent` node's write/Bash mode
(design [`CLAUDE-CODE-NODE.md`](../../docs/design/CLAUDE-CODE-NODE.md) §8b.1). This slice
ships and **proves the network isolation** before any credentialed clone/PR flow rides on it.

## The boundary

```
                 ┌──────────────────────── naary-sandbox-internal (internal: true, NO gateway)
                 │
   ephemeral     │   ┌───────────────┐         ┌──────────────────┐
   claude   ─────┼──▶│ sandbox-proxy │────────▶│ api.anthropic.com │   ✅ (allowlisted)
   container     │   │ (squid ACL)   │────────▶│  anything else    │   ❌ (denied)
                 │   └───────────────┘
                 │        │ also on naary-sandbox-egress (bridge → internet)
   direct →  ✗ ──┘   (the proxy is the ONLY thing with a route out)
```

- **`naary-sandbox-internal`** is `internal: true` → no default gateway. A container here
  **structurally cannot** route to the internet, the host, cloud metadata (`169.254.169.254`),
  or any other stack. Its only reachable peer is the proxy.
- **`sandbox-proxy`** (squid, `squid-allowlist.conf`) permits exactly one thing: a TLS
  `CONNECT` to `api.anthropic.com:443`. Everything else is denied.
- `HTTPS_PROXY` in the sandbox is how the **legitimate** Anthropic call routes — it is **not**
  the security mechanism. The no-gateway network is. Even a fully-hijacked run that ignores
  the proxy has nowhere to go.

## Prove it (the acceptance gate)

```bash
./deploy/sandbox/egress-test.sh
```

Brings the proxy up (a separate compose project, torn down via an `EXIT` trap) and runs a
plain `curl` container **inside** `naary-sandbox-internal`, asserting: Anthropic reachable via
the proxy (an upstream 4xx); `example.com` (via proxy), a public IP (direct), and the metadata
endpoint all **blocked**. Prints `✅ EGRESS OK …` or fails non-zero.

> Note: the sandbox network/proxy use **fixed names** (`naary-sandbox-*`) because the runner
> dials them by name — so run the test when the sandbox stack is **not** already up, or it
> will reuse/conflict on those names.

**codeAgent write/Bash mode stays disabled until this passes on the deploy host.** Slice 1's
read-only path (in-worker, capability-clamped) is unaffected.

## Build the sandbox image

```bash
docker build -t naary-claude-sandbox:latest deploy/sandbox
```

Node + `@anthropic-ai/claude-code` + git, non-root, read-only root at run time. Launched only
by the runner (`@naary/sandbox-runner`), which **pins this image** and constructs a hardened
`docker run` (`--rm`, `--cap-drop ALL`, `no-new-privileges`, cpu/mem/pids caps, key forwarded
by name — never inline). The git token never enters the sandbox.

## Not in this slice (next)

The runner **HTTP service** + the worker→runner **dispatch** + the two-box **clone → diff**.
Those layer on now that the boundary is proven.
