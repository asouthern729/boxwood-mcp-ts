// Fails if an MCP tool exists that the Boxwood Assistant's catalog doesn't know about, or if the
// catalog names a tool that no longer exists. Run: npx tsx scripts/checkAssistantCatalog.ts
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { ASSISTANT_PAGES, NOT_IN_APP_TOOLS } from "../src/assistant/catalog.js"

function toolFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? toolFiles(full) : full.endsWith(".ts") ? [full] : []
  })
}

const registered = new Set(
  toolFiles("src/tools").flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((match) => match[1]))
)

const known = new Set([...ASSISTANT_PAGES.flatMap((page) => page.mcpCapabilities), ...NOT_IN_APP_TOOLS])

const missing = [...registered].filter((name) => !known.has(name))
const stale = [...known].filter((name) => !registered.has(name))

if(missing.length) console.error(`Tools missing from src/assistant/catalog.ts: ${ missing.join(", ") }`)
if(stale.length) console.error(`Catalog names tools that no longer exist: ${ stale.join(", ") }`)

if(missing.length || stale.length) process.exit(1)
console.log(`Assistant catalog covers all ${ registered.size } MCP tools.`)
