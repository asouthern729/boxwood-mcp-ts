import Anthropic from "@anthropic-ai/sdk"
import { ASSISTANT_SYSTEM_PROMPT, describeContext } from "../assistant/systemPrompt.js"
import type { AssistantContext } from "../assistant/systemPrompt.js"

// The Boxwood Assistant: a plain Messages API call with no tools, so it can explain the app, answer
// insurance questions and read files the user attached, but can't reach AMS360 data or run anything.
const MODEL = "claude-sonnet-5-5"

export type AssistantMessage = { role: "user" | "assistant", content: string }

export type AssistantTurnResult = {
  text: string
  stopReason: string | null
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number | null
    cacheCreationInputTokens: number | null
  }
}

let client: Anthropic | null = null

function anthropic(): Anthropic {
  client ??= new Anthropic()
  return client
}

// `documents` are the files attached to the chat (assistantAttachments.ts). They go at the start of
// the first user message, the last one marked as a cache breakpoint so follow-up questions reread
// them from cache instead of paying for them in full each turn.
export async function streamAssistantReply(
  messages: AssistantMessage[],
  context: AssistantContext | undefined,
  onDelta: (text: string) => void,
  signal: AbortSignal,
  documents: Anthropic.Beta.BetaRequestDocumentBlock[] = []
): Promise<AssistantTurnResult> {
  const apiMessages: Anthropic.Beta.BetaMessageParam[] = messages.map((m, i) => (i === 0 && documents.length > 0 ? {
    role: m.role,
    content: [
      ...documents.map((d, j) => (j === documents.length - 1 ? { ...d, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } } : d)),
      { type: "text" as const, text: m.content }
    ]
  } : m))

  const stream = anthropic().beta.messages.stream({
    model: MODEL,
    max_tokens: 4096,
    // Chat answers don't need deep reasoning; low effort keeps replies quick. Reading a document
    // carefully needs a little more.
    output_config: { effort: documents.length > 0 ? "medium" : "low" },
    // A safety-classifier decline on Sonnet 5.5 is retried server-side where a fallback applies.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [
      // Identical on every request, so it's cached; the page context goes after the breakpoint.
      { type: "text", text: ASSISTANT_SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: describeContext(context) }
    ],
    messages: apiMessages
  }, { signal })

  let text = ""

  for await (const event of stream) {
    if(event.type === "content_block_delta" && event.delta.type === "text_delta") {
      text += event.delta.text
      onDelta(event.delta.text)
    }
  }

  const final = await stream.finalMessage()

  return {
    text,
    stopReason: final.stop_reason,
    usage: {
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      cacheReadInputTokens: final.usage.cache_read_input_tokens,
      cacheCreationInputTokens: final.usage.cache_creation_input_tokens
    }
  }
}
