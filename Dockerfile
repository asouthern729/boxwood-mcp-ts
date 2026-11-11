# Build stage: compile src/ → dist/ for the web server.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime: the web server (node dist/app.js) and, in the `jobs` service, supercronic running
# cron/crontab → cron/run-job.sh → `node --import tsx scripts/<job>.ts`.
FROM node:24-bookworm-slim
# Headless LibreOffice + metric-compatible fonts for Word → PDF (src/utils/docxToPdf.ts).
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice-writer-nogui fonts-crosextra-carlito fonts-liberation2 tzdata \
  && rm -rf /var/lib/apt/lists/*
# supercronic runs the scheduled jobs in the `jobs` service (cron/crontab); checksum from its release.
ADD --chmod=755 --checksum=sha256:cc232108374e8e2b537045f2d5eaa1229f619db314c3ba6a14d38b35dc0aa123 \
  https://github.com/aptible/supercronic/releases/download/v0.2.51/supercronic-linux-amd64 /usr/local/bin/supercronic
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Logos and .xlsx templates — resolved as ../../assets from dist/utils and src/utils alike.
COPY assets ./assets
# The cron scripts import ../src/*.ts directly via tsx, so both ship as source.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY cron ./cron
# Static info pages (/mcp-tools/, /roadmap/, /ams360-sync/), served by src/routes/site.ts.
COPY site ./site
USER node
EXPOSE 3000
CMD ["node", "dist/app.js"]
