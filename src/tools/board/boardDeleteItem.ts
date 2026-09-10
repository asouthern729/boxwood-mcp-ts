import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { Comment } from "../../models/index.js"
import { logger } from "../../utils/logger.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { resolveBoardItem } from "./resolveBoardItem.js"

export function registerBoardDeleteItemTool(server: McpServer) {
  server.registerTool(
    "board_delete_item",
    {
      description: "Permanently delete an item (and every comment on it) from the Boxwood/Tyneside tool roadmap. This is destructive and can't be undone. The tool itself will prompt the connected user to confirm before deleting anything, if the client supports that. If it doesn't (the tool will say so), explicitly ask the person you're working with to confirm in chat first, then call this again with confirm: true — never set confirm: true without having actually gotten a real yes from them first.",
      inputSchema: {
        id: z.number().int().describe("Exact item id, from board_summary").optional(),
        name: z.string().describe("Partial, case-insensitive match against the item's name — used if id isn't given").optional(),
        confirm: z.boolean().describe("Only set true after the human has explicitly confirmed deletion in chat — only needed when the client can't show the built-in confirmation prompt this tool tries first").optional()
      }
    },
    async ({ id, name, confirm }) => {
      try {
        const item = await resolveBoardItem(id, name)
        const itemId = item.get("id") as number
        const itemName = item.get("name") as string
        const commentCount = await Comment.count({ where: { item_id: itemId } })

        let confirmed = confirm === true

        if(!confirmed) {
          try {
            const elicitResult = await server.server.elicitInput({
              message: `Delete "${ itemName }" from the roadmap${ commentCount ? ` along with its ${ commentCount } comment(s)` : "" }? This can't be undone.`,
              requestedSchema: {
                type: "object",
                properties: {
                  confirm: {
                    type: "boolean",
                    title: "Delete it",
                    description: "Confirm permanent deletion"
                  }
                },
                required: ["confirm"]
              }
            })

            confirmed = elicitResult.action === "accept" && elicitResult.content?.confirm === true
          } catch{
            return errorResult(new Error(`This client can't show a confirmation prompt directly. Ask the person you're working with to confirm deleting "${ itemName }", then call board_delete_item again with confirm: true.`))
          }

          if(!confirmed) {
            return textResult({ deleted: false, message: `Cancelled — "${ itemName }" was not deleted.` })
          }
        }

        await item.destroy()

        return textResult({ deleted: true, item: itemName })
      } catch(error) {
        logger.error({ err: error, id, name }, "board_delete_item failed")
        return errorResult(error)
      }
    }
  )
}
