# Build stage: compile src/ → dist/ for the web server.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime: the web server (node dist/app.js) and the cron jobs (deploy/run-job.sh runs
# `node --import tsx scripts/<job>.ts` in a one-off container of this same image).
FROM node:24-bookworm-slim
# Headless LibreOffice + metric-compatible fonts for Word → PDF (src/utils/docxToPdf.ts).
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice-writer-nogui fonts-crosextra-carlito fonts-liberation2 \
  && rm -rf /var/lib/apt/lists/*
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
USER node
EXPOSE 3000
CMD ["node", "dist/app.js"]
