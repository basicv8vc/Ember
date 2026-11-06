# Ember Cloud Staging images — API and Worker.
#
# One Dockerfile, two runtime targets, one shared build. Both images are built from the
# same lockfile and the same compiled output, so the API and Worker can never drift apart.
#
#   docker build -f infra/staging/docker/Dockerfile --target api    -t ember-api:<tag>    .
#   docker build -f infra/staging/docker/Dockerfile --target worker -t ember-worker:<tag> .
#
# Build arguments are pinned on purpose:
#   NODE_IMAGE    exact Node.js patch release (must satisfy package.json engines: 24.x)
#   PNPM_VERSION  exact package manager release (must equal package.json packageManager)
#
# NODE_ENV is deliberately NOT baked into the image. The API refuses to start with
# NODE_ENV=production until the dev tenant credential loader is split from the production
# composition (see docs/CLOUD-STAGING-SECURITY.md, residual risk R-1). Staging sets
# NODE_ENV=staging through the environment file, which keeps every development-only code
# path closed.

ARG NODE_IMAGE=node:24.22.1-bookworm-slim
ARG PNPM_VERSION=12.15.0

# --------------------------------------------------------------------------------------
# Stage: toolchain — Node plus the exact pnpm release from package.json.
# --------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS toolchain

ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && pnpm --version

WORKDIR /app

# --------------------------------------------------------------------------------------
# Stage: deps — resolve the workspace exactly from the lockfile.
#
# Only manifests are copied first so a source-only change reuses this layer. Every workspace
# manifest must be present: a frozen install compares the whole importer set against
# pnpm-lock.yaml.
# --------------------------------------------------------------------------------------
FROM toolchain AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/benchmark/package.json apps/benchmark/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/credentials/package.json packages/credentials/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/execution/package.json packages/execution/package.json
COPY packages/postgres/package.json packages/postgres/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --reporter=append-only

# --------------------------------------------------------------------------------------
# Stage: build — compile the workspace with the checked-in build graph.
#
# `pnpm build` runs `tsc -b tsconfig.build.json`, the same command CI runs, so the image
# cannot be produced from sources that fail the type check.
# --------------------------------------------------------------------------------------
FROM deps AS build

COPY tsconfig.base.json tsconfig.build.json tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY migrations ./migrations

RUN pnpm build \
 && test -f apps/api/dist/index.js \
 && test -f apps/worker/dist/index.js \
 && test -f packages/postgres/dist/cli/migrate.js

# --------------------------------------------------------------------------------------
# Stage: prod-deps — drop every development dependency after the build.
# --------------------------------------------------------------------------------------
FROM build AS prod-deps

RUN rm -rf node_modules \
      apps/*/node_modules \
      packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --reporter=append-only

# --------------------------------------------------------------------------------------
# Stage: api
# --------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api

ARG EMBER_IMAGE_VERSION=dev

LABEL org.opencontainers.image.title="ember-api" \
      org.opencontainers.image.description="Ember Cloud API (staging)" \
      org.opencontainers.image.version="${EMBER_IMAGE_VERSION}" \
      org.opencontainers.image.source="https://github.com/basicv8vc/Ember"

ENV NODE_OPTIONS=--enable-source-maps
WORKDIR /app

COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages ./packages
COPY --from=prod-deps /app/apps/api ./apps/api
COPY --from=prod-deps /app/migrations ./migrations

# Artifact blob root and blob volume are created here so a named volume inherits the
# unprivileged ownership on first mount.
RUN groupadd --gid 10001 ember \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin ember \
 && mkdir -p /var/lib/ember/blobs \
 && chown -R 10001:10001 /var/lib/ember

USER 10001:10001

EXPOSE 8787

# Liveness only: the container is healthy when the HTTP listener answers, independent of
# PostgreSQL (that is what /readyz is for).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.EMBER_PORT || '8787') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "apps/api/dist/index.js"]

# --------------------------------------------------------------------------------------
# Stage: worker
# --------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS worker

ARG EMBER_IMAGE_VERSION=dev

LABEL org.opencontainers.image.title="ember-worker" \
      org.opencontainers.image.description="Ember durable Worker (staging)" \
      org.opencontainers.image.version="${EMBER_IMAGE_VERSION}" \
      org.opencontainers.image.source="https://github.com/basicv8vc/Ember"

ENV NODE_OPTIONS=--enable-source-maps
WORKDIR /app

COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages ./packages
COPY --from=prod-deps /app/apps/worker ./apps/worker
COPY --from=prod-deps /app/migrations ./migrations

# The probe lives inside the Worker package so `import('@ember/postgres')` resolves through
# the workspace links the application itself uses.
COPY --chmod=0555 infra/staging/scripts/worker-probe.mjs /app/apps/worker/worker-probe.mjs

RUN groupadd --gid 10001 ember \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin ember \
 && mkdir -p /var/lib/ember/blobs \
 && chown -R 10001:10001 /var/lib/ember

USER 10001:10001

# The Worker owns no socket. Health is "the process can still reach PostgreSQL and is not
# leaving a claimable backlog behind"; see docs/CLOUD-STAGING-DEPLOYMENT.md §8.
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=3 \
  CMD ["node", "apps/worker/worker-probe.mjs"]

CMD ["node", "apps/worker/dist/index.js"]
