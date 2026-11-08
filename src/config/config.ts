import path from "node:path"

// The public hostname the app is served on: PUBLIC_HOST in .env (e.g. demo.tyneside.io), else
// demo.tyneside.io. Only used in production; development always runs on 127.0.0.1. It sets both the
// Host header the app accepts and the base of every link it hands out (downloads, OAuth metadata).
export const allowedHosts = process.env.NODE_ENV === "production" ?
  [process.env.PUBLIC_HOST || "demo.tyneside.io"] :
  ["127.0.0.1"]

export const publicBaseUrl = `https://${ allowedHosts[0] }`

// Where generated documents, their manifests and uploaded files live: OUTPUT_ROOT in .env
// (production: /var/lib/boxwood-mcp/output, outside the checkout so a re-clone or git clean can't
// take the archive with it). Without it, scripts/output in the checkout, as before. Never under the
// nginx web root: every file is served through the app's auth or download tokens.
// Read when called, so it only needs dotenv loaded before the first archive module is evaluated.
export function outputDir(...parts: string[]): string {
  return path.join(process.env.OUTPUT_ROOT || path.join(import.meta.dirname, "..", "..", "scripts", "output"), ...parts)
}

// Where the cron jobs keep their place between runs (download-report watermark, PL job cursors):
// STATE_ROOT in .env (production: /var/lib/boxwood-mcp/state), else scripts/state in the checkout.
// Losing one makes a job re-report or skip rows, so it lives outside the checkout like outputDir.
export function stateDir(...parts: string[]): string {
  return path.join(process.env.STATE_ROOT || path.join(import.meta.dirname, "..", "..", "scripts", "state"), ...parts)
}
