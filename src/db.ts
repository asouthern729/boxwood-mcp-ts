import { Pool } from "pg"
import { formatTimestampColumn } from "./utils/localTime.js"

export const pool = new Pool()

const STATEMENT_TIMEOUT_MS = 10_000

export async function runReadOnlyQuery(sql: string, params: unknown[] = []) {
  const client = await pool.connect()

  try {
    await client.query("BEGIN TRANSACTION READ ONLY")
    await client.query(`SET LOCAL statement_timeout = ${ STATEMENT_TIMEOUT_MS }`)
    const result = await client.query(sql, params)
    return result.rows.map(localizeTimestamps)
  } finally {
    await client.query("ROLLBACK")
    client.release()
  }
}

// Every tool reads through this function, so this is the single place that converts raw
// timestamp/date columns (which pg parses into Date objects) to agency-local, offset-suffixed
// strings before they ever reach a client — see utils/localTime.ts for why.
function localizeTimestamps(row: Record<string, unknown>): Record<string, unknown> {
  const localized: Record<string, unknown> = {}

  for(const [key, value] of Object.entries(row)) {
    localized[key] = value instanceof Date ? formatTimestampColumn(value, key) : value
  }

  return localized
}
