import { query } from "@anthropic-ai/claude-agent-sdk"
import { createServer } from "../mcpServer.js"
import { logger } from "./logger.js"

// Same reasoning as boardChat.ts/scripts/morningDownload.ts: force API-key auth (never an ambient
// OAuth session) and fail fast if it's missing, since this is what actually authenticates every call.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

if(!ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY must be set (see .env.example) for the tool page chat features")
}

export type ScopedChatTurn = {
  reply: string
  sessionId: string
  toolCalls: { name: string, input: unknown }[]
}

// The embedded chat behind a CL tool page (risk-profile, cl-renewal-summary): one turn against this
// server's own MCP tools, restricted to exactly `toolNames`, resumable by session id.
export async function runScopedChatTurn(
  message: string,
  resumeSessionId: string | undefined,
  { toolNames, systemPrompt, logLabel }: { toolNames: string[]; systemPrompt: string; logLabel: string }
): Promise<ScopedChatTurn> {
  const server = createServer()

  const result = query({
    prompt: message,
    options: {
      model: "claude-sonnet-5",
      // Each turn here is a narrow, deterministic choice among a handful of tools per an explicit
      // system prompt — not open-ended reasoning — so the SDK's 'high' (deep reasoning) default just
      // adds latency for no quality benefit. 'low' cuts real wall-clock time per turn, which matters
      // a lot for a broad request that legitimately needs several sequential tool calls.
      effort: "low",
      mcpServers: { boxwood: { type: "sdk", name: "boxwood", instance: server } },
      // `tools` actually restricts the toolset (unlike `allowedTools`, which only pre-approves
      // without narrowing it) — both together mean the chat only ever has the tools passed in.
      tools: toolNames,
      allowedTools: toolNames,
      // Isolates this from the project's own accumulated .claude/settings.json permissions (see
      // boardChat.ts's comment on the same option) — only `tools`/`allowedTools` above govern what
      // this run can touch.
      settingSources: [],
      permissionMode: "default",
      maxTurns: 20,
      systemPrompt,
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
      logger.warn({ subtype: msg.subtype }, `[${ logLabel }] turn ended without a clean success result`)
    }
  }

  if(!sessionId) {
    throw new Error(`${ logLabel } turn produced no messages`)
  }

  return { reply: reply.trim(), sessionId, toolCalls }
}
