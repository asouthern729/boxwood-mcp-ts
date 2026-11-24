// One-off cleanup (2026-11-24): removes the Word comments Claude used to leave on generated documents
// ("Added by Claude from uploaded quote …", "Premiums added by Claude …") from the CL Renewal Summaries
// and Proposal Builder proposals already archived on the server. New documents no longer get them
// (clProposalDoc.ts). The files are edited in place — no rebuild from AMS360, so nothing else in a
// document changes — and only comments authored "Claude" are removed.
//
// Each changed file's original is copied to <OUTPUT_ROOT>/claude-comment-strip-backup/<dir>/ first.
//
// Usage: npx tsx scripts/stripClaudeDocComments.ts [--dry-run]
//   --dry-run  reports which files have Claude comments, and how many, without changing anything.
// In the jobs container: node --import tsx scripts/stripClaudeDocComments.ts [--dry-run]

import "dotenv/config"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import JSZip from "jszip"
import { outputDir } from "../src/config/config.js"

const DIRS = ["cl-renewal-summary", "proposal-builder"]
const AUTHOR = "Claude"
const BACKUP_ROOT = outputDir("claude-comment-strip-backup")

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Returns the cleaned file, or null when it has no Claude comments.
async function strip(buffer: Buffer): Promise<{ buffer: Buffer; removed: number } | null> {
  const zip = await JSZip.loadAsync(buffer)
  const commentsFile = zip.file("word/comments.xml")
  const documentFile = zip.file("word/document.xml")
  if(!commentsFile || !documentFile) return null

  let comments = await commentsFile.async("string")
  const ids: string[] = []
  comments = comments.replace(/<w:comment\b[^>]*>[\s\S]*?<\/w:comment>/g, (element) => {
    const open = element.match(/^<w:comment\b[^>]*>/)![0]
    const author = open.match(/\bw:author="([^"]*)"/)?.[1]
    const id = open.match(/\bw:id="([^"]*)"/)?.[1]
    if(author !== AUTHOR || id == null) return element
    ids.push(id)
    return ""
  })
  if(ids.length === 0) return null

  let document = await documentFile.async("string")
  for(const id of ids) {
    const idAttr = `w:id="${ escape(id) }"`
    document = document
      .replace(new RegExp(`<w:commentRange(?:Start|End)\\b[^>]*${ idAttr }[^>]*/>`, "g"), "")
      // The run that holds only the comment's reference mark.
      .replace(new RegExp(`<w:r>(?:(?!</w:r>)[\\s\\S])*?<w:commentReference\\b[^>]*${ idAttr }[^>]*/>(?:(?!</w:r>)[\\s\\S])*?</w:r>`, "g"), "")
      // A reference outside its own run, if any.
      .replace(new RegExp(`<w:commentReference\\b[^>]*${ idAttr }[^>]*/>`, "g"), "")
  }

  zip.file("word/comments.xml", comments)
  zip.file("word/document.xml", document)
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  return { buffer: out, removed: ids.length }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  let files = 0
  let changed = 0
  let removed = 0
  const failed: string[] = []

  for(const dir of DIRS) {
    const root = outputDir(dir)
    if(!existsSync(root)) {
      console.log(`[stripClaudeDocComments] ${ root } doesn't exist — skipping`)
      continue
    }
    for(const name of readdirSync(root).filter((n) => n.toLowerCase().endsWith(".docx"))) {
      files++
      const file = path.join(root, name)
      try {
        const result = await strip(readFileSync(file))
        if(!result) continue
        changed++
        removed += result.removed
        console.log(`[stripClaudeDocComments] ${ dryRun ? "would remove" : "removed" } ${ result.removed } comment(s) from ${ dir }/${ name }`)
        if(dryRun) continue

        const backupDir = path.join(BACKUP_ROOT, dir)
        mkdirSync(backupDir, { recursive: true })
        const backup = path.join(backupDir, name)
        if(!existsSync(backup)) copyFileSync(file, backup)
        const tmp = `${ file }.tmp`
        writeFileSync(tmp, result.buffer)
        renameSync(tmp, file)
      } catch(err) {
        failed.push(`${ dir }/${ name }: ${ (err as Error).message }`)
      }
    }
  }

  console.log(`[stripClaudeDocComments] ${ files } file(s) checked, ${ changed } ${ dryRun ? "would change" : "changed" }, ${ removed } comment(s) ${ dryRun ? "to remove" : "removed" }.${ !dryRun && changed > 0 ? ` Originals in ${ BACKUP_ROOT }.` : "" }`)
  if(failed.length > 0) {
    console.error(`[stripClaudeDocComments] ${ failed.length } failed:\n  ${ failed.join("\n  ") }`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
