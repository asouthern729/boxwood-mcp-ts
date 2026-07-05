import { Pool } from "pg"

export const pool = new Pool()

const STATEMENT_TIMEOUT_MS = 10_000

export async function runReadOnlyQuery(sql: string, params: unknown[] = []) {
  const client = await pool.connect()

  try {
    await client.query("BEGIN TRANSACTION READ ONLY")
    await client.query(`SET LOCAL statement_timeout = ${ STATEMENT_TIMEOUT_MS }`)
    const result = await client.query(sql, params)
    return result.rows
  } finally {
    await client.query("ROLLBACK")
    client.release()
  }
}
