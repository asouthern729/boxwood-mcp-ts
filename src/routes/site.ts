import path from "node:path"
import express from "express"

// The static info pages in site/ (shipped in the image next to dist/ and src/, so ../../site
// resolves from either). Each page keeps the URL nginx used to serve it from /var/www/site: every
// path serves the whole folder (pages use ./assets/... relative links) with its own index page.
// /ams360-sync/summary.json is NOT here — the AMS360 ETL writes it on the host and nginx serves it.
const SITE_DIR = path.join(import.meta.dirname, "..", "..", "site")

const PAGES: Record<string, string> = {
  "/mcp-tools": "mcp-tools.html",
  "/roadmap": "roadmap.html",
  "/ams360-sync": "ams360-sync.html",
}

export const router = express.Router()

for (const [mount, index] of Object.entries(PAGES)) {
  router.use(mount, express.static(SITE_DIR, { index, fallthrough: true }))
}
