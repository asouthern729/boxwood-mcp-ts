import { Op, Model } from "sequelize"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { Item, Comment } from "../../models/index.js"
import { ITEM_STATUSES } from "../../models/types.js"
import type { ItemInterface, ItemCreationInterface } from "../../models/types.js"
import { logger } from "../../utils/logger.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { toLocalizedPlain } from "./localizeBoardTimestamps.js"

export function registerBoardSummaryTool(server: McpServer) {
  server.registerTool(
    "board_summary",
    {
      description: "View the Boxwood/Tyneside tool roadmap — the shared board (site/roadmap.html) tracking client-requested MCP tool ideas, their priority, status, and the comment thread between Andrew and the client on each one. Optionally filter by category (Commercial Lines, Personal Lines, Claims, Employee Benefits, Management Dashboards), status (idea/in_progress/completed), or a partial match on the item's name. With no filters, returns every item grouped in the same category/priority order the page itself uses. Each item includes its full comment thread (author_label, created_at, body) — use this to catch up on the conversation before posting a new comment or changing a status.",
      inputSchema: {
        category: z.string().describe("Partial, case-insensitive match against category (e.g. \"Personal Lines\")").optional(),
        status: z.enum(ITEM_STATUSES).describe("Filter to items with this exact status").optional(),
        name: z.string().describe("Partial, case-insensitive match against the item's name").optional()
      }
    },
    async ({ category, status, name }) => {
      try {
        const where: Record<symbol | string, unknown> = {}

        if(category) where.category = { [Op.iLike]: `%${ category }%` }
        if(status) where.status = status
        if(name) where.name = { [Op.iLike]: `%${ name }%` }

        const items = await Item.findAll({
          where,
          include: [{ model: Comment, as: "comments" }],
          order: [["category", "ASC"], ["priority", "ASC"], ["name", "ASC"]]
        }) as Model<ItemInterface, ItemCreationInterface>[]

        return textResult({ items: items.map(toLocalizedPlain) })
      } catch(error) {
        logger.error({ err: error, category, status, name }, "board_summary failed")
        return errorResult(error)
      }
    }
  )
}
