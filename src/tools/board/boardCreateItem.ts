import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { Item } from "../../models/index.js"
import { ITEM_STATUSES } from "../../models/types.js"

// Types
import { ItemCreationInterface } from "../../models/types.js"
import { logger } from "../../utils/logger.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { toLocalizedPlain } from "./localizeBoardTimestamps.js"

const KNOWN_CATEGORIES = ["Commercial Lines", "Personal Lines", "Claims", "Employee Benefits", "Management Dashboards"]

export function registerBoardCreateItemTool(server: McpServer) {
  server.registerTool(
    "board_create_item",
    {
      description: `Add a new tool idea to the Boxwood/Tyneside roadmap (site/roadmap.html) — the shared board Andrew and the client use to track and discuss what to build next. Use when a new idea comes up in conversation (e.g. the client asks for something new, or Andrew wants to note a follow-up idea) rather than letting it get lost. category is freeform but should match one of the existing categories when it fits: ${ KNOWN_CATEGORIES.join(", ") }. Everything except category and name is optional and can be filled in later via board_update_item.`,
      inputSchema: {
        category: z.string().describe(`e.g. one of: ${ KNOWN_CATEGORIES.join(", ") } — or a new category if none fit`),
        name: z.string().describe("Short name for the tool idea"),
        status: z.enum(ITEM_STATUSES).default("idea"),
        // Mirrors PRIORITY_LEVELS in models/types.ts — kept as literal 1/2/3 here since zod's
        // z.literal union doesn't take a runtime array directly.
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).describe("1, 2, or 3 — omit if not yet prioritized").optional(),
        owner: z.string().describe("Who's driving this idea, if known").optional(),
        use_type: z.string().describe("e.g. Internal, External, Internal/External").optional(),
        process: z.string().describe("e.g. Renewal, New Business, Daily").optional(),
        output: z.string().describe("What it produces, e.g. Spreadsheet, Word Document, Email").optional(),
        trigger_desc: z.string().describe("What kicks it off, e.g. \"individual request\", \"every night automated\"").optional(),
        source_data: z.string().describe("Where its data comes from, e.g. MCP data, PDF Quote Doc upload").optional(),
        notes: z.string().describe("Any other context").optional()
      }
    },
    async ({ category, name, status, priority, owner, use_type, process, output, trigger_desc, source_data, notes }) => {
      try {
        const item = await Item.create({
          category,
          name,
          status,
          priority: priority ?? null,
          owner: owner ?? null,
          use_type: use_type ?? null,
          process: process ?? null,
          output: output ?? null,
          trigger_desc: trigger_desc ?? null,
          source_data: source_data ?? null,
          notes: notes ?? null
        } satisfies ItemCreationInterface)

        return textResult({ created: toLocalizedPlain(item) })
      } catch(error) {
        logger.error({ err: error, category, name, status, priority }, "board_create_item failed")
        return errorResult(error)
      }
    }
  )
}
