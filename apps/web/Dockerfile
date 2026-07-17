# syntax=docker/dockerfile:1
# Web app image: build the Vite SPA, then serve the static bundle with nginx.
# Build context is the REPO ROOT (see docker-compose.yml) so the pnpm workspace
# resolves — the web app may import browser-safe workspace types (@naary/contracts).

# --- build stage ---------------------------------------------------------------
# Node 22 (LTS): pnpm 11 requires Node >= 22.
FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Firebase web config — Vite inlines VITE_* env at build time, so these must be
# present BEFORE `vite build`. Passed as build args from docker-compose/.env
# (public values; UNSET ⇒ the SPA's Firebase login is unavailable).
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_APP_ID
# Sentry (browser): the DSN is a PUBLISHABLE value (safe in the bundle), inlined at
# build time. UNSET ⇒ Sentry stays off in the SPA (see apps/web/src/instrument.ts).
ARG VITE_SENTRY_DSN
ARG VITE_SENTRY_TRACES_SAMPLE_RATE
ARG VITE_SENTRY_PROFILES_SAMPLE_RATE
ARG VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE
ARG VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE
ARG VITE_APP_VERSION
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
  VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
  VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
  VITE_FIREBASE_STORAGE_BUCKET=$VITE_FIREBASE_STORAGE_BUCKET \
  VITE_FIREBASE_MESSAGING_SENDER_ID=$VITE_FIREBASE_MESSAGING_SENDER_ID \
  VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID \
  VITE_SENTRY_DSN=$VITE_SENTRY_DSN \
  VITE_SENTRY_TRACES_SAMPLE_RATE=$VITE_SENTRY_TRACES_SAMPLE_RATE \
  VITE_SENTRY_PROFILES_SAMPLE_RATE=$VITE_SENTRY_PROFILES_SAMPLE_RATE \
  VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE=$VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE \
  VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE=$VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE \
  VITE_APP_VERSION=$VITE_APP_VERSION

COPY . .
# Install workspace deps, build the web app's workspace deps (@naary/dsl — its
# dist/ is .dockerignore'd, and the web build is vite-only so it won't build deps
# itself), then typecheck + vite build (the web `build` script). tsc -b on dsl
# follows its project references, so any transitive package is built too.
# BuildKit cache mount for the pnpm store (see the backend Dockerfile) — persists the
# downloaded packages across builds so a source change doesn't re-download them. Build-only.
RUN --mount=type=cache,target=/pnpm-store \
  pnpm install --frozen-lockfile --store-dir /pnpm-store \
  && pnpm --filter @naary/dsl run build \
  && pnpm --filter @naary/web run build

# --- runtime stage -------------------------------------------------------------
FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
