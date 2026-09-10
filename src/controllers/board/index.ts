import asyncHandler from "../../middleware/async/index.js"
import { Item, Comment } from "../../models/index.js"
import { ITEM_STATUSES, PRIORITY_LEVELS } from "../../models/types.js"

// Types
import { Request, Response, NextFunction } from "express"
import { Model } from "sequelize"
import { ItemInterface, ItemCreationInterface, CommentInterface, CommentCreationInterface } from "../../models/types.js"
import { ErrorResponse } from "../../utils/errorResponse.js"
import { runBoardChatTurn } from "../../utils/boardChat.js"

const MAX_LABEL_LENGTH = 80
const MAX_BODY_LENGTH = 4000
const MAX_CHAT_MESSAGE_LENGTH = 2000

export const getItems = asyncHandler(async(_req: Request, res: Response<{ data: Model<ItemInterface, ItemCreationInterface>[] }>, _next: NextFunction) => {
  const items = await Item.findAll({
    include: [{ model: Comment, as: "comments" }],
    order: [["category", "ASC"], ["priority", "ASC"], ["name", "ASC"]]
  }) as Model<ItemInterface, ItemCreationInterface>[]

  res.status(200).json({
    data: items
  })
})

export const updateItem = asyncHandler(async(req: Request<{ id: string }>, res: Response<{ data: Model<ItemInterface, ItemCreationInterface> }>, next: NextFunction) => {
  const item = await Item.findOne({ where: { id: req.params.id } }) as Model<ItemInterface, ItemCreationInterface>

  if(!item) {
    return next(new ErrorResponse(`Unable to find board item by id ${ req.params.id }`, 404))
  }

  const { status, priority, notes, owner } = req.body ?? {}
  const updates: Partial<ItemInterface> = {}

  if(status !== undefined) {
    if(!ITEM_STATUSES.includes(status)) {
      return next(new ErrorResponse(`status must be one of: ${ ITEM_STATUSES.join(", ") }`, 400))
    }
    updates.status = status
  }

  if(priority !== undefined) {
    if(priority !== null && !(PRIORITY_LEVELS as readonly number[]).includes(priority)) {
      return next(new ErrorResponse(`priority must be one of: ${ PRIORITY_LEVELS.join(", ") }, or null`, 400))
    }
    updates.priority = priority
  }

  if(notes !== undefined) {
    if(notes !== null && typeof notes !== "string") {
      return next(new ErrorResponse("notes must be a string or null", 400))
    }
    updates.notes = notes
  }

  if(owner !== undefined) {
    if(owner !== null && typeof owner !== "string") {
      return next(new ErrorResponse("owner must be a string or null", 400))
    }
    updates.owner = owner
  }

  await item.update(updates)

  res.status(200).json({
    data: item
  })
})

export const createComment = asyncHandler(async(req: Request<{ id: string }>, res: Response<{ data: Model<CommentInterface, CommentCreationInterface> }>, next: NextFunction) => {
  const item = await Item.findOne({ where: { id: req.params.id } }) as Model<ItemInterface, ItemCreationInterface>

  if(!item) {
    return next(new ErrorResponse(`Unable to find board item by id ${ req.params.id }`, 404))
  }

  const { author_label, author_email, body } = req.body ?? {}

  if(typeof author_label !== "string" || !author_label.trim() || author_label.length > MAX_LABEL_LENGTH) {
    return next(new ErrorResponse(`author_label is required and must be ${ MAX_LABEL_LENGTH } characters or fewer`, 400))
  }

  if(author_email !== undefined && author_email !== null && typeof author_email !== "string") {
    return next(new ErrorResponse("author_email must be a string or null", 400))
  }

  if(typeof body !== "string" || !body.trim() || body.length > MAX_BODY_LENGTH) {
    return next(new ErrorResponse(`body is required and must be ${ MAX_BODY_LENGTH } characters or fewer`, 400))
  }

  const authorSub = req.auth0?.sub

  if(!authorSub) {
    return next(new ErrorResponse("Not authorized to access this route", 401))
  }

  const comment = await Comment.create({
    item_id: Number(req.params.id),
    author_label: author_label.trim(),
    author_sub: authorSub,
    author_email: author_email ?? null,
    body: body.trim()
  }) as Model<CommentInterface, CommentCreationInterface>

  res.status(201).json({
    data: comment
  })
})

export const deleteComment = asyncHandler(async(req: Request<{ id: string, commentId: string }>, res: Response, next: NextFunction) => {
  const comment = await Comment.findOne({
    where: { id: req.params.commentId, item_id: req.params.id }
  }) as Model<CommentInterface, CommentCreationInterface>

  if(!comment) {
    return next(new ErrorResponse(`Unable to find comment by id ${ req.params.commentId }`, 404))
  }

  const authorSub = req.auth0?.sub

  if(!authorSub || comment.get("author_sub") !== authorSub) {
    return next(new ErrorResponse("Not authorized to delete this comment", 403))
  }

  await comment.destroy()

  res.status(204).send()
})

export const postChat = asyncHandler(async(req: Request, res: Response, next: NextFunction) => {
  const { message, session_id } = req.body ?? {}

  if(typeof message !== "string" || !message.trim() || message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return next(new ErrorResponse(`message is required and must be ${ MAX_CHAT_MESSAGE_LENGTH } characters or fewer`, 400))
  }

  if(session_id !== undefined && typeof session_id !== "string") {
    return next(new ErrorResponse("session_id must be a string", 400))
  }

  const turn = await runBoardChatTurn(message.trim(), session_id)

  res.status(200).json({
    reply: turn.reply,
    session_id: turn.sessionId,
    tool_calls: turn.toolCalls
  })
})
