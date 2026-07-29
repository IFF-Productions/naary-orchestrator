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
> dials them by name — so run the test when the sandbox stack is **not** already up (that
> now includes the prod stack's `sandbox` profile), or it will reuse/conflict on those names.

**codeAgent write/Bash mode stays disabled until this passes on the deploy host.**

> Since #680 there is no un-sandboxed path left: codeAgent READ (and the api's `claude-code`
> "Build with AI" source) now REQUIRE this stack. Without it they fail loudly with
> `CODE_AGENT_SANDBOX_UNCONFIGURED` / a 503 naming the settings to add — deliberately, so a
> missing sandbox can never silently degrade into running a CLI inside the api/worker process.

## Build the sandbox images — one per tool

Each coding CLI gets its **own** image whose `ENTRYPOINT` is that CLI's binary. That is what makes
"the argv reached the wrong CLI" structurally impossible: the runner maps `tool` → image from its
own config, and a request can only name a tool from a closed set, never an image. (Before #680 a
single claude-entrypoint image was pinned for all tools — see #933.)

```bash
docker build -t naary-claude-sandbox:latest  deploy/sandbox
docker build -t naary-cursor-sandbox:latest  -f deploy/sandbox/cursor.Dockerfile  deploy/sandbox
docker build -t naary-copilot-sandbox:latest -f deploy/sandbox/copilot.Dockerfile deploy/sandbox
docker build -t naary-gemini-sandbox:latest  -f deploy/sandbox/gemini.Dockerfile  deploy/sandbox
```

Build only the tools you actually offer — and trim `squid-allowlist.conf` to match, since every
host listed there is somewhere a hijacked run could post a key. Override any image with
`SANDBOX_IMAGE_{CLAUDE,CURSOR,COPILOT,GEMINI}` (pin by digest in production).

Each is Node + that CLI + git, non-root, read-only root at run time. Launched only by the runner
(`@naary/sandbox-runner`), which **pins the image** and constructs a hardened `docker run`
(`--rm`, `--cap-drop ALL`, `no-new-privileges`, cpu/mem/pids caps, tmpfs `/tmp` + HOME, key
forwarded by name — never inline). The git token never enters the sandbox.

### Smoke-test them

```bash
deploy/sandbox/smoke-test.sh            # all four, or name the ones you built
```

`egress-test.sh` proves the network containment; this proves each image can actually *start* under
those isolation flags with an empty workdir. Worth running after any CLI version bump — all four
images failed it on the first attempt for four different reasons (unwritable HOME, a dangling
symlink, a `noexec` native addon), and none of those are visible to the unit tests.

## In production

The proxy + runner now live in the **prod compose set**
([`deploy/docker-compose.prod.yml`](../docker-compose.prod.yml), profile `sandbox`) — this
file's compose is the standalone/dev version and what `egress-test.sh` drives. On the deploy
host `deploy/sandbox/` is shipped to `/opt/naary/deploy/sandbox` (the prod overlay
bind-mounts the squid allowlist from there), and enabling the runner is three steps:

```bash
cd /opt/naary                                                # 1. the tool images you offer
docker build -t naary-claude-sandbox:latest deploy/sandbox
#   …plus cursor/copilot/gemini with -f, as above
/opt/naary/deploy/sandbox/egress-test.sh                     # 2. the egress gate
/opt/naary/deploy/sandbox/smoke-test.sh                      # 3. each image starts
# 4. add SANDBOX_RUNNER_TOKEN=<random> + COMPOSE_PROFILES=sandbox to /opt/naary/.env
#    (the api reads the same two vars — it dispatches "Build with AI" runs here too)
```

The runner image itself is built + pushed by CI (`naary-sandbox-runner`, per release tag),
so the box only pulls it. The runner publishes **no port**: the worker reaches it in-network
at `SANDBOX_RUNNER_URL` with `SANDBOX_RUNNER_TOKEN` (see `deploy/.env.prod.example`).

Running the profile and enabling `CODE_AGENT_WRITE_ENABLED` are separate decisions — the
first only makes the infrastructure available.
