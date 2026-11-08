import { Sequelize, DataTypes } from "sequelize"
import { logger } from "../utils/logger.js"
import defineEmployee from "./Employee.js"

export const sequelize = new Sequelize({
  dialect: "postgres",
  logging: (msg) => logger.debug(msg)
})

export const Employee = defineEmployee(sequelize, DataTypes)

const models = { Employee }

for(const model of Object.values(models)) {
  model.associate()
}

export default { sequelize, Sequelize, ...models }
