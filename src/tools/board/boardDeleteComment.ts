import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { Comment } from "../../models/index.js"
import { logger } from "../../utils/logger.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"

// Matches boardComment.ts's own MCP_AUTHOR_SUB constant — kept as a separate literal here
// (rather than importing it) so this file's own safety check reads standalone at the point that
// matters, without relying on staying in sync with a value defined elsewhere. Andrew's and the
// client's comments always carry a real Auth0 "sub" claim, never literally "mcp-tool", so this
// can't accidentally delete a human's comment even if a caller passes an id that happens to
// belong to one — it just refuses.
const MCP_AUTHOR_SUB = "mcp-tool"

export function registerBoardDeleteCommentTool(server: McpServer) {
  server.registerTool(
    "board_delete_comment",
    {
      description: "Delete one of Claude's own comments from a roadmap item's thread (site/roadmap.html) — never a human's. Only ever deletes a comment whose author is \"Claude\" (the same fixed identity board_comment posts under); refuses with an error if the given id belongs to a comment posted by Andrew or the client, even if explicitly asked to remove it. No confirmation prompt (unlike board_delete_item, which can remove a whole item's worth of other people's comments too) — this only ever touches Claude's own prior remarks, so it's safe to call without asking first. Get the id from board_summary's per-item comments array.",
      inputSchema: {
        id: z.number().int().describe("Exact comment id, from board_summary's comments array")
      }
    },
    async ({ id }) => {
      try {
        const comment = await Comment.findOne({ where: { id } })

        if(!comment) throw new Error(`No comment found with id ${ id }`)

        if(comment.get("author_sub") !== MCP_AUTHOR_SUB) {
          throw new Error(`Comment ${ id } wasn't posted by Claude — refusing to delete another author's comment.`)
        }

        const body = comment.get("body") as string
        const itemId = comment.get("item_id") as number

        await comment.destroy()

        return textResult({ deleted: true, item_id: itemId, body })
      } catch(error) {
        logger.error({ err: error, id }, "board_delete_comment failed")
        return errorResult(error)
      }
    }
  )
}
