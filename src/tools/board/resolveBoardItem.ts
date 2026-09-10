import { Op, Model } from "sequelize"
import { Item } from "../../models/index.js"
import type { ItemInterface, ItemCreationInterface } from "../../models/types.js"

// Shared by board_update_item and board_comment — both need to turn a caller-given `id` (exact)
// or `name` (partial, case-insensitive) into exactly one boxwood_mcp.items row, or a clear error
// otherwise. Errors are plain messages (caught by the calling tool's try/catch -> errorResult),
// not thrown Sequelize/DB errors, since a "no match"/"multiple matches" case is a normal, expected
// outcome here, not a real failure.
export async function resolveBoardItem(id: number | undefined, name: string | undefined) {
  if(id !== undefined) {
    const item = await Item.findOne({ where: { id } }) as Model<ItemInterface, ItemCreationInterface> | null
    if(!item) throw new Error(`No roadmap item found with id ${ id }`)
    return item
  }

  if(!name) {
    throw new Error("Provide either id or name to identify the roadmap item")
  }

  const matches = await Item.findAll({ where: { name: { [Op.iLike]: `%${ name }%` } } }) as Model<ItemInterface, ItemCreationInterface>[]

  if(matches.length === 0) {
    throw new Error(`No roadmap item found matching name "${ name }"`)
  }

  if(matches.length > 1) {
    const names = matches.map((match) => match.get("name")).join("; ")
    throw new Error(`Multiple roadmap items match "${ name }" — be more specific: ${ names }`)
  }

  return matches[0]
}
