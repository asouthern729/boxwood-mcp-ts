import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { ITEM_STATUSES } from "../../models/types.js"
import { logger } from "../../utils/logger.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { resolveBoardItem } from "./resolveBoardItem.js"
import { toLocalizedPlain } from "./localizeBoardTimestamps.js"

export function registerBoardUpdateItemTool(server: McpServer) {
  server.registerTool(
    "board_update_item",
    {
      description: "Update one item on the Boxwood/Tyneside tool roadmap (site/roadmap.html) — its status, priority level, and/or notes. Identify the item by id (exact, from board_summary) or name (partial match — errors listing the candidates if more than one matches). At least one of status/priority/notes is required. priority is 1/2/3 or null (pass null to clear it). Use this after finishing work on something (e.g. set status to completed) or to reprioritize — this is the same board the client sees and comments on, so a change here is visible to them immediately.",
      inputSchema: {
        id: z.number().int().describe("Exact item id, from board_summary").optional(),
        name: z.string().describe("Partial, case-insensitive match against the item's name — used if id isn't given").optional(),
        status: z.enum(ITEM_STATUSES).optional(),
        // Mirrors PRIORITY_LEVELS in models/types.ts — kept as literal 1/2/3 here since zod's
        // z.literal union doesn't take a runtime array directly.
        priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.null()]).describe("1, 2, 3, or null to clear it").optional(),
        notes: z.string().nullable().describe("Pass null to clear existing notes").optional()
      }
    },
    async ({ id, name, status, priority, notes }) => {
      try {
        if(status === undefined && priority === undefined && notes === undefined) {
          throw new Error("Provide at least one of status, priority, or notes to update")
        }

        const item = await resolveBoardItem(id, name)

        const updates: Record<string, unknown> = {}
        if(status !== undefined) updates.status = status
        if(priority !== undefined) updates.priority = priority
        if(notes !== undefined) updates.notes = notes

        await item.update(updates)

        return textResult({ updated: toLocalizedPlain(item) })
      } catch(error) {
        logger.error({ err: error, id, name, status, priority, notes }, "board_update_item failed")
        return errorResult(error)
      }
    }
  )
}
