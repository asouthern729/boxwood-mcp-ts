import { Sequelize, DataTypes } from "sequelize"
import { logger } from "../utils/logger.js"
import defineEmployee from "./Employee.js"
import defineItem from "./Item.js"
import defineComment from "./Comment.js"

export const sequelize = new Sequelize({
  dialect: "postgres",
  logging: (msg) => logger.debug(msg)
})

export const Employee = defineEmployee(sequelize, DataTypes)
export const Item = defineItem(sequelize, DataTypes)
export const Comment = defineComment(sequelize, DataTypes)

// Wired here (rather than inside each model's own associate()) to avoid a circular
// import between Item.ts and Comment.ts.
Item.hasMany(Comment, { foreignKey: "item_id", as: "comments" })
Comment.belongsTo(Item, { foreignKey: "item_id", as: "item" })

const models = { Employee, Item, Comment }

for(const model of Object.values(models)) {
  model.associate()
}

export default { sequelize, Sequelize, ...models }
