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

export const devToolsEnabled = process.env.ENABLE_DEV_TOOLS === "true"

const devPool = devToolsEnabled ?
  new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT) || 5432,
    database: process.env.PGDATABASE,
    user: process.env.DEV_PGUSER,
    password: process.env.DEV_PGPASSWORD
  }) :
  undefined

export async function runWriteQuery(sql: string, params: unknown[] = []) {
  if(!devPool) throw new Error("Dev tools are disabled")

  const client = await devPool.connect()

  try {
    await client.query("BEGIN")
    const result = await client.query(sql, params)
    await client.query("COMMIT")
    return result.rows
  } catch(error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
