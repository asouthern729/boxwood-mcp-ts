'use strict';

import { Model, Sequelize, DataTypes } from "sequelize"
import type { CommentInterface, CommentCreationInterface } from "./types.js"

export default (sequelize: Sequelize, dataTypes: typeof DataTypes) => {
  class Comment extends Model<CommentInterface, CommentCreationInterface>{
    declare id: number
    declare item_id: number | null
    declare author_label: string
    declare author_sub: string
    declare author_email: string | null
    declare body: string
    declare created_at: Date

    // Cross-model associations (Item <-> Comment) are wired in models/index.ts,
    // right after both models are created, to avoid a circular import between the two files.
    static associate(){}
  }

  Comment.init({
    id: {
      type: dataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    item_id: {
      type: dataTypes.INTEGER
    },
    author_label: {
      type: dataTypes.TEXT,
      allowNull: false
    },
    author_sub: {
      type: dataTypes.TEXT,
      allowNull: false
    },
    author_email: {
      type: dataTypes.TEXT
    },
    body: {
      type: dataTypes.TEXT,
      allowNull: false
    },
    created_at: {
      type: dataTypes.DATE,
      allowNull: false,
      defaultValue: dataTypes.NOW
    }
  },{
    sequelize,
    schema: "boxwood_mcp",
    freezeTableName: true,
    tableName: "comments",
    modelName: "Comment",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false
  })

  return Comment
}
