'use strict';

import { Model, Sequelize, DataTypes } from "sequelize"
import type { ItemInterface, ItemCreationInterface, ItemStatus, PriorityLevel } from "./types.js"
import { ITEM_STATUSES, PRIORITY_LEVELS } from "./types.js"

export default (sequelize: Sequelize, dataTypes: typeof DataTypes) => {
  class Item extends Model<ItemInterface, ItemCreationInterface>{
    declare id: number
    declare category: string
    declare name: string
    declare priority: PriorityLevel | null
    declare owner: string | null
    declare status: ItemStatus
    declare use_type: string | null
    declare process: string | null
    declare output: string | null
    declare trigger_desc: string | null
    declare source_data: string | null
    declare notes: string | null
    declare created_at: Date
    declare updated_at: Date

    // Cross-model associations (Item <-> Comment) are wired in models/index.ts,
    // right after both models are created, to avoid a circular import between the two files.
    static associate(){}
  }

  Item.init({
    id: {
      type: dataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    category: {
      type: dataTypes.TEXT,
      allowNull: false
    },
    name: {
      type: dataTypes.TEXT,
      allowNull: false
    },
    priority: {
      type: dataTypes.INTEGER,
      // Sequelize's built-in `isIn` validator delegates to validator.js, which expects a string —
      // unsafe for a numeric column, hence this explicit check instead (unlike `status` above,
      // which is a string column and can use `isIn` directly).
      validate: {
        isValidPriorityLevel(value: unknown) {
          if(value !== null && !(PRIORITY_LEVELS as readonly number[]).includes(value as number)) {
            throw new Error(`priority must be one of: ${ PRIORITY_LEVELS.join(", ") }, or null`)
          }
        }
      }
    },
    owner: {
      type: dataTypes.TEXT
    },
    status: {
      type: dataTypes.TEXT,
      allowNull: false,
      defaultValue: "idea",
      validate: { isIn: [[...ITEM_STATUSES]] }
    },
    use_type: {
      type: dataTypes.TEXT
    },
    process: {
      type: dataTypes.TEXT
    },
    output: {
      type: dataTypes.TEXT
    },
    trigger_desc: {
      type: dataTypes.TEXT
    },
    source_data: {
      type: dataTypes.TEXT
    },
    notes: {
      type: dataTypes.TEXT
    },
    created_at: {
      type: dataTypes.DATE,
      allowNull: false,
      defaultValue: dataTypes.NOW
    },
    updated_at: {
      type: dataTypes.DATE,
      allowNull: false,
      defaultValue: dataTypes.NOW
    }
  },{
    sequelize,
    schema: "boxwood_mcp",
    freezeTableName: true,
    tableName: "items",
    modelName: "Item",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at"
  })

  return Item
}
