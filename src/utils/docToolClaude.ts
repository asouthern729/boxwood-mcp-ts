import Anthropic, { toFile } from "@anthropic-ai/sdk"
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import type * as z from "zod"
import { logger } from "./logger.js"
import { UploadReadError, WORKBOOK_NOTE, documentBlock, type ReadableDoc } from "./uploadNormalize.js"

// The one big read behind each upload-and-run document tool (Policy Check, CL Coverage
// Comparison, Coverage Gap): every document in one request — PDFs uploaded through the Files API so
// the request stays far under the 32 MB body limit, workbooks inline as text (uploadNormalize.ts) —
// one structured answer back, uploads deleted afterwards.

export const DOC_TOOL_MODEL = "claude-opus-5-5"
// Opus 5.5 takes up to 600 PDF pages in one request.
export const MAX_TOTAL_PAGES = 600

let client: Anthropic | null = null
export const anthropic = () => (client ??= new Anthropic())

// Errors whose message is written for staff and can be shown as-is. The same class as upload errors
// (uploadNormalize.ts), so a file that can't be converted reports its own message.
export { UploadReadError as DocToolError }
const DocToolError = UploadReadError

export type DocumentGroup = { heading: string; documents: { title: string; filename: string; doc: ReadableDoc }[] }

export async function analyzeDocuments<T extends z.ZodType>({ groups, trailingText, system, schema, logLabel }: {
  groups: DocumentGroup[]
  trailingText: string
  system: string
  schema: T
  logLabel: string
}): Promise<z.infer<T>> {
  const tooBig = "These documents produced more than fits in one run. Split them up and run again."
  const unreadable = "The documents were read but the result couldn't be used. Run it again."
  const uploaded: string[] = []

  try {
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = []
    for(const group of groups) {
      if(group.documents.length === 0) continue
      blocks.push({ type: "text", text: group.heading })
      for(const { title, filename, doc } of group.documents) {
        if(doc.format === "text") {
          blocks.push(documentBlock(doc, title))
          continue
        }
        const meta = await anthropic().files.upload({ file: await toFile(doc.data, filename, { type: "application/pdf" }) })
        uploaded.push(meta.id)
        blocks.push({ type: "document", source: { type: "file", file_id: meta.id }, title })
      }
    }
    const hasWorkbook = groups.some((g) => g.documents.some((d) => d.doc.format === "text"))
    blocks.push({ type: "text", text: hasWorkbook ? `${ trailingText }\n\n${ WORKBOOK_NOTE }` : trailingText })

    const stream = anthropic().beta.messages.stream({
      model: DOC_TOOL_MODEL,
      max_tokens: 128000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content: blocks }]
    })

    let response: Awaited<ReturnType<typeof stream.finalMessage>>
    try {
      response = await stream.finalMessage()
    } catch(error) {
      if(error instanceof Anthropic.APIError) throw error
      throw new DocToolError(stream.currentMessage?.stop_reason === "max_tokens" ? tooBig : unreadable)
    }

    logger.info({ usage: response.usage, stop_reason: response.stop_reason }, `${ logLabel }: analysis finished`)
    if(response.stop_reason === "refusal") throw new DocToolError("The documents couldn't be read (the request was declined). Try different copies of the files.")
    if(response.stop_reason === "max_tokens") throw new DocToolError(tooBig)
    if(!response.parsed_output) throw new DocToolError(unreadable)
    return response.parsed_output as z.infer<T>
  } finally {
    for(const id of uploaded) {
      await anthropic().files.delete(id).catch((err: unknown) => logger.warn({ err, id }, `${ logLabel }: couldn't delete uploaded file`))
    }
  }
}
