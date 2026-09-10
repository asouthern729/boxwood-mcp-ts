import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { Comment } from "../../models/index.js"
import { logger } from "../../utils/logger.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { resolveBoardItem } from "./resolveBoardItem.js"
import { toLocalizedPlain } from "./localizeBoardTimestamps.js"

const MAX_BODY_LENGTH = 4000

// Fixed identity for every MCP-posted comment — distinct from a real Auth0 login (Andrew or the
// client, via site/roadmap.html), so it's always clear on the page a comment came from an
// assistant session rather than either person. author_email is deliberately null: the page's
// bubble coloring only recognizes Andrew's real email as "blue", so this renders as the default
// (pink/"theirs") bubble — no dedicated third color exists for this yet.
const MCP_AUTHOR_LABEL = "Claude"
const MCP_AUTHOR_SUB = "mcp-tool"

export function registerBoardCommentTool(server: McpServer) {
  server.registerTool(
    "board_comment",
    {
      description: "Post a comment on one item on the Boxwood/Tyneside tool roadmap (site/roadmap.html) — the same comment thread Andrew and the client use to communicate about that tool idea. Identify the item by id (exact, from board_summary) or name (partial match — errors listing the candidates if more than one matches). Every comment posted through this tool is attributed to \"Claude\", visible to both Andrew and the client on the page.",
      inputSchema: {
        id: z.number().int().describe("Exact item id, from board_summary").optional(),
        name: z.string().describe("Partial, case-insensitive match against the item's name — used if id isn't given").optional(),
        body: z.string().min(1).max(MAX_BODY_LENGTH).describe("The comment text")
      }
    },
    async ({ id, name, body }) => {
      try {
        const item = await resolveBoardItem(id, name)

        const comment = await Comment.create({
          item_id: item.get("id") as number,
          author_label: MCP_AUTHOR_LABEL,
          author_sub: MCP_AUTHOR_SUB,
          author_email: null,
          body
        })

        return textResult({ posted: toLocalizedPlain(comment) })
      } catch(error) {
        logger.error({ err: error, id, name }, "board_comment failed")
        return errorResult(error)
      }
    }
  )
}
