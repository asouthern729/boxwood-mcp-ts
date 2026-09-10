import { Router } from "express"
import { getItems, updateItem, createComment, deleteComment, postChat } from "../controllers/board/index.js"
import auth0 from "../middleware/auth/auth0/index.js"

export const router = Router()

const BASE = "/api/v1/boxwood-mcp" as const

router
  .route(`${ BASE }/board/items`)
  .get(auth0, getItems)

router
  .route(`${ BASE }/board/items/:id`)
  .patch(auth0, updateItem)

router
  .route(`${ BASE }/board/items/:id/comments`)
  .post(auth0, createComment)

router
  .route(`${ BASE }/board/items/:id/comments/:commentId`)
  .delete(auth0, deleteComment)

router
  .route(`${ BASE }/board/chat`)
  .post(auth0, postChat)
