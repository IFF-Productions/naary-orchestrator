# Deployment resources & cloud cost comparison

Everything the naary-orchestrator needs to run in a real (non-local) environment, and what each
piece costs across providers. Aimed at a **low-traffic smoke test / small prod**, so sizing is
minimal. All prices are **approximate, USD/month, early-2026 list prices** — verify current rates;
regions, tiers, and free grants change.

> **The two things that shape the bill:** (1) the **worker must run 24/7** (it long-polls Temporal),
> so it can't scale to zero — always-on compute is unavoidable. (2) the app needs **Postgres with
> `pgvector`** and a **Temporal** backend. Everything else is small.

---

## 1. Resources the app needs

| # | Resource | Why | Minimal sizing |
|---|----------|-----|----------------|
| 1 | **Compute — worker** | Temporal worker: the generic interpreter + activities. Long-polls Temporal → **always-on**, no scale-to-zero. | 0.5 vCPU / 1 GB |
| 2 | **Compute — api** | NestJS control plane (HTTP): start/approve/state, connections, webhooks. | 0.25 vCPU / 0.5 GB |
| 3 | **Compute — web** | React SPA (static). Served by nginx **or** any static host/CDN. | tiny / static |
| 4 | **Database** | Postgres **with `pgvector`** (definitions, tenants, usage ledger, RAG vectors). | 1 shared vCPU / 1 GB, ~20 GB |
| 5 | **Temporal** | Durable execution backend. **Temporal Cloud** (managed) or self-hosted server + its own DB. | Cloud namespace, or 1 container |
| 6 | **Ingress + TLS** | HTTPS on your domain, routes `/api/*`→api, `/*`→web. | 1 LB / built-in / Caddy |
| 7 | **DNS** | A/CNAME records for the domain. | 1 hosted zone |
| 8 | **Container registry** | Store the `naary-backend` + `naary-web` images. | 2 repos, ~1 GB |
| 9 | **Secrets** | `ENCRYPTION_KEY`, provider keys, Firebase SA, `DATABASE_URL`, Temporal creds. | ~6 secrets |
| 10 | **Object storage** | S3-compatible claim-check store for large LLM/file payloads (`STORAGE_PROVIDER=s3`). Optional for a light smoke test (defaults to in-memory). | 1 bucket, <1 GB |
| 11 | **Observability** *(optional)* | Sentry DSN + metrics scrape. External/optional. | — |

**One-shot job:** `migrate` runs `prisma migrate deploy` once per deploy (a task/job, not a service).

**Migration note (host):** run `prisma generate` via `pnpm --filter @naary/db run generate` (loads
`.env`) — bare `prisma generate` fails without `DATABASE_URL`.

---

## 2. Per-resource price comparison

### 2.1 Always-on compute (per small service; you need ~2–3)

| Provider / service | Unit (≈0.5 vCPU / 1 GB) | ~$/mo | Notes |
|---|---|---|---|
| **Hetzner Cloud** CX32 (4 vCPU / 8 GB) | whole VM, runs everything | **€6.80 (~$7.5)** | Cheapest credible. One box for all services. |
| **Oracle Cloud** Ampere A1 (free) | whole VM (≤4 OCPU / 24 GB) | **$0** | Always-free; ARM; capacity can be hard to get. |
| **AWS Lightsail** | 2 GB plan | **$12** | Flat price incl. transfer; simplest AWS VM. |
| **AWS EC2** t4g.small (2 vCPU / 2 GB, ARM) | whole VM | **~$12** | Free tier t3.micro 12 mo (too small for all-in-one). |
| **AWS Fargate** | 0.5 vCPU / 1 GB task | **~$18** | Per task. Spot ≈ −70%. |
| **AWS App Runner** | 0.5 vCPU / 1 GB | **~$25+** | Pricier than Fargate for always-on. |
| **GCP Cloud Run** (min-instances=1) | 0.5 vCPU / 1 GB always-warm | **~$15–20** | Scale-to-zero **not** usable for the worker. HTTPS+domain built-in (no LB fee). |
| **GCP GCE** e2-small (2 vCPU / 2 GB) | whole VM | **~$13** | e2-micro always-free (US, too small for all-in-one). |
| **Azure Container Apps** | 0.5 vCPU / 1 GB active | **~$15–20** | Free monthly grant; similar to Fargate. |
| **Azure VM** B2s (2 vCPU / 4 GB) | whole VM | **~$30** | B1s (1/1) ~$8 too small. |
| **Fly.io** shared-cpu-1x / 1 GB | per machine | **~$5.70** | Cheap; Anycast + TLS included. |
| **DigitalOcean** droplet 2 GB | whole VM | **$12** | App Platform $5+/component. |
| **Render** | 512 MB web / worker | **$7 each** | Simple PaaS; 2 GB = $25. |
| **Railway** | usage-based | **~$5–20** | $5 hobby credit + metered. |

> **Key:** a **single VM** runs *all three* services (+ optionally Postgres & Temporal) for one price.
> Container platforms (Fargate/Cloud Run/Container Apps) bill **per service**, so ×2–3.

### 2.2 Database — Postgres **with pgvector**

| Provider / option | pgvector | ~$/mo | Notes |
|---|---|---|---|
| **Neon** free tier | ✅ | **$0** | 0.5 GB, autosuspends when idle. Best $0 managed option. |
| **Supabase** free | ✅ | **$0** | 500 MB, pauses after ~1 wk inactivity. |
| **Self-hosted on the VM** | ✅ | **$0** | pgvector container; uses VM RAM. Cheapest with a VM. |
| **AWS RDS free tier** | ✅ (PG 15/16) | **$0** | Only if account < 12 months (750 h db.t3.micro). |
| **GCP Cloud SQL** db-f1-micro | ✅ | **~$9** | + storage. db-g1-small ~$25. |
| **Azure PG Flexible** B1ms | ✅ | **~$13** | Burstable. |
| **AWS RDS** db.t4g.micro | ✅ | **~$14** | ~$12 instance + ~$2 storage, single-AZ. AWS-native cheapest. |
| **Neon / Supabase** paid | ✅ | **$19 / $25** | Autoscale, no idle-suspend. |
| **AWS Aurora Serverless v2** | ✅ | **~$43+** | ❌ 0.5-ACU floor = most expensive here. Avoid for smoke test. |

### 2.3 Temporal (durable execution backend)

| Option | ~$/mo | Notes |
|---|---|---|
| **Temporal Cloud** (free trial) | **$0** | $1000 credits; then usage-based (per-action + storage). Low smoke-test usage ≈ a few $ or covered. **No infra to run.** |
| **Self-hosted** (`temporalio/temporal` container + shared Postgres) | **$0 extra on a VM** | Adds 1 container + schema to your Postgres. Free on a VM; heavy as extra Fargate tasks. |
| **Temporal Cloud** (post-trial, small) | **~$25+** | Once credits run out. |

### 2.4 Ingress + TLS

| Provider / option | ~$/mo | Notes |
|---|---|---|
| **Caddy / Traefik on a VM** | **$0** | Auto Let's Encrypt TLS. Best with the single-VM route. |
| **Cloudflare** (proxy in front) | **$0** | Free tier proxies + TLS; hides origin. |
| **Fly.io / Cloud Run / Container Apps** built-in | **$0** | HTTPS + custom domain included — **no separate LB**. |
| **GCP HTTPS LB** | **~$18** | Only if not using Cloud Run's built-in. |
| **AWS ALB** | **~$16** | + LCU. The main fixed cost of the ECS route. |
| **AWS Lightsail LB** | **$18** | Rarely needed. |

### 2.5 DNS · registry · secrets · object storage (all small)

| Resource | Cheapest | ~$/mo | Others |
|---|---|---|---|
| **DNS** | Cloudflare | **$0** | Route 53 $0.50/zone · Cloud DNS $0.20/zone |
| **Registry** | GHCR / Docker Hub | **$0** | ECR ~$0.10/GB · Artifact Registry ~$0.10/GB |
| **Secrets** | SSM Parameter Store / env file | **$0** | Secrets Manager $0.40/secret · GCP/Azure similar |
| **Object storage** | Cloudflare R2 | **~$0** (<1 GB) | R2 $0.015/GB **$0 egress** · Backblaze B2 $0.006/GB · S3 $0.023/GB + $0.09/GB egress · GCS ≈ S3 |

> **R2 / B2** are notably cheaper than S3 for object storage because **egress is free** — relevant if
> large payloads flow out often. All are S3-API-compatible with the app's `S3ObjectStore`.

---

## 3. Reference architectures (totals)

### A. Single small VM — **cheapest** ⭐
Everything (api + worker + web + Postgres + optional Temporal) in one `docker compose`, TLS via Caddy.

| Item | Choice | $/mo |
|---|---|---|
| VM | Hetzner CX32 (8 GB) | ~$7.5 |
| Postgres | container on the VM | $0 |
| Temporal | self-host on VM **or** Temporal Cloud (trial) | $0 |
| TLS + DNS | Caddy + Cloudflare | $0 |
| Object storage | R2 (or in-memory for a light test) | ~$0 |
| **Total** | | **≈ $7.5** (or **$0** on Oracle free tier) |

### B. AWS ECS Fargate + Temporal Cloud
Fargate services + ALB + managed DB. AWS-native, autoscaling, no server to babysit.

| Item | Choice | $/mo |
|---|---|---|
| Fargate — worker | 0.5 vCPU / 1 GB | ~$18 |
| Fargate — api | 0.25 vCPU / 0.5 GB | ~$9 |
| Web | S3 + CloudFront (static) | ~$1 |
| Ingress | ALB + ACM | ~$16 |
| Database | **Neon free** (or RDS t4g.micro +$14) | $0 (or $14) |
| Temporal | Temporal Cloud (trial) | $0 |
| DNS / ECR / SSM / S3 | Route 53 + ECR + SSM | ~$2 |
| **Total** | | **≈ $46** (Neon) / **≈ $60** (RDS) |
| *Trimmed* | Fargate **Spot** worker + web on S3 | **≈ $28–32** |

> **No NAT Gateway** — put Fargate tasks in **public** subnets with public IPs (saves ~$32/mo).

### C. GCP Cloud Run + Temporal Cloud
Built-in HTTPS + domain mapping means **no load-balancer fee** — a real edge over ECS.

| Item | Choice | $/mo |
|---|---|---|
| Cloud Run — worker | min-instances=1 (always-warm) | ~$15–20 |
| Cloud Run — api | min-instances=1 | ~$8–15 |
| Web | Cloud Storage + Cloud CDN | ~$1 |
| Ingress + TLS | Cloud Run built-in | $0 |
| Database | Neon free (or Cloud SQL f1-micro +$9) | $0 (or $9) |
| Temporal | Temporal Cloud (trial) | $0 |
| DNS / Artifact Registry | Cloud DNS + AR | ~$0.30 |
| **Total** | | **≈ $25–37** |

### D. Fly.io + Temporal Cloud
Small machines, Anycast + TLS included, very little boilerplate.

| Item | Choice | $/mo |
|---|---|---|
| Machines | worker + api + web (shared-1x) | ~$13 |
| Database | Neon free (or Fly Postgres ~$5) | $0 (or $5) |
| Temporal | Temporal Cloud (trial) | $0 |
| TLS + DNS | Fly built-in + Cloudflare | $0 |
| **Total** | | **≈ $13–18** |

### E. All-free smoke test
| Item | Choice | $/mo |
|---|---|---|
| Compute | Oracle Cloud Ampere (free) — compose | $0 |
| Database | Neon free (or on the VM) | $0 |
| Temporal | Temporal Cloud trial (or self-host on VM) | $0 |
| TLS / DNS / registry | Caddy + Cloudflare + GHCR | $0 |
| **Total** | | **$0** *(caveats: Oracle capacity, free-tier limits)* |

---

## 4. Side-by-side summary

| Architecture | ~$/mo | Effort | Best when |
|---|---|---|---|
| **A. Single VM** ⭐ | **$0–8** | Low (it's your compose) | Cheapest; mirrors local; smoke test / small prod |
| **E. All-free** | **$0** | Low–Med | Zero budget; OK with free-tier limits |
| **D. Fly.io** | **$13–18** | Low | Cheap PaaS, minimal ops, global |
| **C. GCP Cloud Run** | **$25–37** | Med | Serverless containers, no LB fee, GCP shop |
| **B. AWS ECS Fargate** | **$28–60** | Med–High | AWS-native, autoscaling, prod-like topology |

---

## 5. Recommendation

- **Cheapest / fastest smoke test:** **A — single small VM** running your existing `docker-compose`
  (Hetzner ~$7.5, or Oracle free = $0), Postgres on-box or **Neon free**, **Temporal Cloud** (free
  trial), TLS via **Caddy**, DNS via **Cloudflare**. This is 2–5× cheaper than ECS and closest to
  what already works locally.
- **If you want ECS specifically** (autoscaling, prod-like): **B**, and the two levers that matter are
  **DB = Neon free (−$14 vs RDS)** and **web on S3/CloudFront + Fargate Spot worker** → **~$30/mo**.
  The **ALB (~$16)** is the unavoidable fixed cost of that route.
- **DB across all routes:** for a smoke test use **Neon free ($0, has pgvector)**; move to RDS/Cloud
  SQL/Neon-paid (~$14–25) only when you outgrow the free tier or want it inside your cloud.
- **Temporal:** **Temporal Cloud** on the free trial removes the heaviest infra everywhere — keep it.

> Prices are list estimates for low usage; always confirm current pricing and free-tier eligibility
> for your account/region before committing.
