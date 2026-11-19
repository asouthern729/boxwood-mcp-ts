import path from "node:path"

// Hostnames this deployment answers to (Host-header check in createMcpExpressApp, and the only
// origins /logout will send a browser back to). ALLOWED_HOSTS in .env, comma-separated, so one image
// can run at mcp.boxwoodins.com or build.tyneside.io; unset keeps the old per-NODE_ENV default.
const DEFAULT_HOSTS = process.env.NODE_ENV === "production" ? ["mcp.boxwoodins.com"] : ["127.0.0.1"]

const configuredHosts = (process.env.ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean)

export const allowedHosts = configuredHosts.length > 0 ? configuredHosts : DEFAULT_HOSTS

// Public origin used for the OAuth callback, OAuth metadata and download links. PUBLIC_BASE_URL in
// .env overrides it; otherwise the first allowed host over https, as before.
export const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `https://${ allowedHosts[0] }`).replace(/\/+$/, "")

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
