import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { runReadOnlyQuery, runWriteQuery, devToolsEnabled } from "./db.js"

const SELECT_ONLY_PATTERN = /^select\b/i

function assertSingleStatement(sql: string) {
  const trimmed = sql.trim()
  const withoutTrailingSemicolon = trimmed.endsWith(";") ?
    trimmed.slice(0, -1) :
    trimmed

  if(withoutTrailingSemicolon.includes(";")) {
    throw new Error("Multiple statements are not allowed")
  }

  return withoutTrailingSemicolon
}

function assertSelectOnly(sql: string) {
  const withoutTrailingSemicolon = assertSingleStatement(sql)

  if(!SELECT_ONLY_PATTERN.test(withoutTrailingSemicolon)) {
    throw new Error("Only single SELECT statements are allowed")
  }

  return withoutTrailingSemicolon
}

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
  }
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  return {
    content: [{ type: "text" as const, text: message }],
    isError: true
  }
}

export function createServer() {
  const server = new McpServer({
    name: "boxwood-mcp-ts",
    version: "1.0.0"
  })

  server.registerTool(
    "list_tables",
    {
      description: "List all tables in the boxwood-ams360 database, grouped by schema",
      inputSchema: {}
    },
    async () => {
      try {
        const rows = await runReadOnlyQuery(`
          SELECT table_schema, table_name
          FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY table_schema, table_name
        `)

        return textResult(rows)
      } catch(error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    "describe_table",
    {
      description: "Describe the columns of a table, including type, nullability, default, and primary key membership",
      inputSchema: {
        table: z.string().describe("Table name"),
        schema: z.string().default("public").describe("Schema name, defaults to 'public'")
      }
    },
    async ({ table, schema }) => {
      try {
        const rows = await runReadOnlyQuery(
          `
            SELECT
              c.column_name,
              c.data_type,
              c.is_nullable,
              c.column_default,
              EXISTS (
                SELECT 1
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                  AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_schema = c.table_schema
                  AND tc.table_name = c.table_name
                  AND kcu.column_name = c.column_name
              ) AS is_primary_key
            FROM information_schema.columns c
            WHERE c.table_schema = $1 AND c.table_name = $2
            ORDER BY c.ordinal_position
          `,
          [schema, table]
        )

        if(rows.length === 0) {
          return errorResult(`No columns found for ${ schema }.${ table } — check the table exists`)
        }

        return textResult(rows)
      } catch(error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    "run_query",
    {
      description: "Run a read-only SELECT query against boxwood-ams360 and return the resulting rows",
      inputSchema: {
        sql: z.string().describe("A single SELECT statement")
      }
    },
    async ({ sql }) => {
      try {
        const safeSql = assertSelectOnly(sql)
        const rows = await runReadOnlyQuery(safeSql)

        return textResult(rows)
      } catch(error) {
        return errorResult(error)
      }
    }
  )

  if(devToolsEnabled) {
    server.registerTool(
      "run_write_query",
      {
        description: "DEV ONLY: run a single write/DDL statement (CREATE/INSERT/UPDATE/DELETE/etc.) against boxwood-ams360 as the andrew role. Not available in production.",
        inputSchema: {
          sql: z.string().describe("A single SQL statement")
        }
      },
      async ({ sql }) => {
        try {
          const safeSql = assertSingleStatement(sql)
          const rows = await runWriteQuery(safeSql)

          return textResult(rows)
        } catch(error) {
          return errorResult(error)
        }
      }
    )
  }

  return server
}
