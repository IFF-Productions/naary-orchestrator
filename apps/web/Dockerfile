# Web app image: build the Vite SPA, then serve the static bundle with nginx.
# Build context is the REPO ROOT (see docker-compose.yml) so the pnpm workspace
# resolves — the web app may import browser-safe workspace types (@naary/contracts).

# --- build stage ---------------------------------------------------------------
# Node 22 (LTS): pnpm 11 requires Node >= 22.
FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY . .
# Install workspace deps, build the web app's workspace deps (@naary/dsl — its
# dist/ is .dockerignore'd, and the web build is vite-only so it won't build deps
# itself), then typecheck + vite build (the web `build` script). tsc -b on dsl
# follows its project references, so any transitive package is built too.
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @naary/dsl run build \
  && pnpm --filter @naary/web run build

# --- runtime stage -------------------------------------------------------------
FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
