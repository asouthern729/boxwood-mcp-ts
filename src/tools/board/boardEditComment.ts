import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { Comment } from "../../models/index.js"
import { logger } from "../../utils/logger.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { toLocalizedPlain } from "./localizeBoardTimestamps.js"

// Same author restriction as board_delete_comment, and for the same reason — see its own comment.
const MCP_AUTHOR_SUB = "mcp-tool"
const MAX_BODY_LENGTH = 4000

export function registerBoardEditCommentTool(server: McpServer) {
  server.registerTool(
    "board_edit_comment",
    {
      description: "Rewrite the full text of one of Claude's own existing comments on a roadmap item (site/roadmap.html) — never a human's; refuses with an error if the given id belongs to a comment posted by Andrew or the client. Meant for cleanup: an earlier comment can end up long or exploratory, and once later replies on the same thread (from Andrew or the client) settle what actually mattered, it's often worth going back and shortening or refining the original instead of leaving it as noise for the next person reading the thread. This replaces the comment's body outright, not a diff — read board_summary first to see the current text and the rest of the thread before rewriting, and keep any observation that's still genuinely useful (rephrase a cross-reference rather than dropping it, same caution board_comment's own description gives for writing one in the first place). Comments record no edit history, so the original text is gone once this runs — only rewrite when the cleanup is clearly worth it, not speculatively.",
      inputSchema: {
        id: z.number().int().describe("Exact comment id, from board_summary's comments array"),
        body: z.string().min(1).max(MAX_BODY_LENGTH).describe("The comment's new, full replacement text")
      }
    },
    async ({ id, body }) => {
      try {
        const comment = await Comment.findOne({ where: { id } })

        if(!comment) throw new Error(`No comment found with id ${ id }`)

        if(comment.get("author_sub") !== MCP_AUTHOR_SUB) {
          throw new Error(`Comment ${ id } wasn't posted by Claude — refusing to edit another author's comment.`)
        }

        await comment.update({ body })

        return textResult({ edited: toLocalizedPlain(comment) })
      } catch(error) {
        logger.error({ err: error, id }, "board_edit_comment failed")
        return errorResult(error)
      }
    }
  )
}
