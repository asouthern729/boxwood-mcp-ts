import { query } from "@anthropic-ai/claude-agent-sdk"
import { createServer } from "../mcpServer.js"
import { logger } from "./logger.js"

// Same reasoning as scripts/morningDownload.ts: force API-key auth (never an ambient OAuth
// session) and fail fast if it's missing, since this is what actually authenticates every call.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

if(!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY must be set (see .env.example) for the roadmap chat feature")
}

const BOARD_TOOL_NAMES = [
  "mcp__boxwood__board_summary",
  "mcp__boxwood__board_update_item",
  "mcp__boxwood__board_comment",
  "mcp__boxwood__board_create_item",
  "mcp__boxwood__board_delete_item"
]

const SYSTEM_PROMPT = `You are the assistant embedded directly on the Boxwood/Tyneside tool roadmap page (site/roadmap.html) — the shared board Andrew (Tyneside, the developer) and the Boxwood client use to track and discuss MCP tool ideas, their priority, and status. You have tools to view the board, update items, create new ideas, post comments, and delete items.

Stay scoped to the roadmap: answer questions about what's on it, help reprioritize, summarize the comment threads, post comments on someone's behalf when asked, and add new ideas that come up in conversation. You have no access to anything outside this board (no customer/policy/AMS360 data, no other part of this app).

board_delete_item is permanent and destructive. If it can't show its own confirmation prompt, it will tell you so directly — when that happens, explicitly ask the person you're talking to for a clear yes before calling it again with confirm: true. Never set confirm: true without having actually gotten that confirmation in this conversation.

Keep replies brief and conversational — this is a small chat panel, not a report.`

export type BoardChatTurn = {
  reply: string
  sessionId: string
  toolCalls: { name: string, input: unknown }[]
}

export async function runBoardChatTurn(message: string, resumeSessionId: string | undefined): Promise<BoardChatTurn> {
  const server = createServer()

  const result = query({
    prompt: message,
    options: {
      model: "claude-sonnet-5",
      mcpServers: { boxwood: { type: "sdk", name: "boxwood", instance: server } },
      // Same rationale as morningDownload.ts: `tools` actually restricts the toolset (unlike
      // `allowedTools`, which only pre-approves without narrowing it), and both together mean the
      // chat only ever has the 5 board tools — never customer/policy/AMS360 data or filesystem/Bash.
      tools: BOARD_TOOL_NAMES,
      allowedTools: BOARD_TOOL_NAMES,
      // Isolates this from the project's own accumulated .claude/settings.json permissions (see
      // morningDownload.ts's comment on the same option) — only `tools`/`allowedTools` above
      // govern what this run can touch.
      settingSources: [],
      permissionMode: "default",
      maxTurns: 20,
      systemPrompt: SYSTEM_PROMPT,
      resume: resumeSessionId,
      env: { ...process.env, ANTHROPIC_API_KEY }
    }
  })

  let sessionId: string | undefined
  let reply = ""
  const toolCalls: { name: string, input: unknown }[] = []

  for await (const msg of result) {
    sessionId = msg.session_id

    if(msg.type === "assistant") {
      for(const block of msg.message.content) {
        if(block.type === "text") {
          reply += block.text
        } else if(block.type === "tool_use") {
          toolCalls.push({ name: block.name, input: block.input })
        }
      }
    } else if(msg.type === "result" && msg.subtype !== "success") {
      logger.warn({ subtype: msg.subtype }, "[board_chat] turn ended without a clean success result")
    }
  }

  if(!sessionId) {
    throw new Error("board chat turn produced no messages")
  }

  return { reply: reply.trim(), sessionId, toolCalls }
}
