import type Anthropic from "@anthropic-ai/sdk"
import ExcelJS from "exceljs"
import { PDFDocument } from "pdf-lib"
import { PdfConverterUnavailableError, convertDocxToPdf, convertXlsToXlsx } from "./docxToPdf.js"

// Every upload tool (CL Renewal Summary quotes, Proposal Builder, Coverage Comparison, Policy Check,
// Coverage Gap) accepts the same file types, and each type is read the same way everywhere
// (Andrew, 2026-11-25). The rule: page documents become PDFs, spreadsheets become text.
//   PDF            → as-is
//   Word (.docx)   → PDF via LibreOffice Writer, so tables, pasted scans and page numbers survive
//   PNG / JPEG     → a one-page PDF (Claude reads a PDF page as an image anyway)
//   Excel (.xlsx)  → text, sheet by sheet, row by row; a printed spreadsheet splits columns across
//                    pages, which reads worse than the cells themselves
//   Excel (.xls)   → .xlsx via LibreOffice Calc, then the same text

export type UploadKind = "pdf" | "docx" | "xlsx" | "xls" | "png" | "jpeg"

export const ACCEPTED_FILES_MESSAGE = "Upload a PDF, Word (.docx), Excel (.xlsx or .xls), or PNG/JPEG file."

// Errors whose message is written for staff and can be shown as-is.
export class UploadReadError extends Error {}

const PDF_HEADER = Buffer.from("%PDF-")
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff])
const OLE_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

// From the bytes, since browsers label Office files inconsistently (or not at all). .xlsx and .docx
// are zips whose entry names (stored as plain text) include xl/workbook or word/document. An OLE
// file is treated as .xls; an old .doc is OLE too, but LibreOffice then fails to make a workbook of
// it and the error says to save it again.
export function sniffUpload(file: Buffer): UploadKind | null {
  const pdfAt = file.indexOf(PDF_HEADER)
  if(pdfAt !== -1 && pdfAt <= 1024) return "pdf"
  if(file.subarray(0, 4).equals(ZIP_HEADER)) {
    if(file.includes("xl/workbook")) return "xlsx"
    if(file.includes("word/document")) return "docx"
    return null
  }
  if(file.subarray(0, 8).equals(PNG_HEADER)) return "png"
  if(file.subarray(0, 3).equals(JPEG_HEADER)) return "jpeg"
  if(file.subarray(0, 8).equals(OLE_HEADER)) return "xls"
  return null
}

// The stored file's extension for a kind, before it's made readable.
export const uploadExt = (kind: UploadKind): string => (kind === "jpeg" ? "jpg" : kind)

// Some carrier portals wrap the download: American Modern's dec page (Patrick's TN Equine email,
// 2026-10-07) starts with a 22-byte Java serialization header before "%PDF-". Desktop viewers skip
// leading junk, but the API rejects the file as "not valid" — so anything before the header is cut.
export function normalizedPdf(pdf: Buffer): Buffer {
  const start = pdf.indexOf(PDF_HEADER)
  if(start === -1 || start > 1024) throw new UploadReadError("This file isn't a PDF. Download it again as a PDF and upload that.")
  return start === 0 ? pdf : pdf.subarray(start)
}

// ---------- Readable form ----------

export type ReadableDoc = { format: "pdf"; data: Buffer } | { format: "text"; data: string }

export async function toReadable(file: Buffer, kind: UploadKind): Promise<ReadableDoc> {
  switch(kind) {
    case "pdf": return { format: "pdf", data: normalizedPdf(file) }
    case "docx": return { format: "pdf", data: await libreOffice(() => convertDocxToPdf(file), "Word") }
    case "png":
    case "jpeg": return { format: "pdf", data: await imageToPdf(file, kind) }
    case "xlsx": return { format: "text", data: await workbookText(file) }
    case "xls": return { format: "text", data: await workbookText(await libreOffice(() => convertXlsToXlsx(file), "Excel")) }
  }
}

// The same, sniffing the kind first (for callers holding just the bytes).
export async function readableUpload(file: Buffer): Promise<ReadableDoc> {
  const kind = sniffUpload(file)
  if(!kind) throw new UploadReadError(ACCEPTED_FILES_MESSAGE)
  return toReadable(file, kind)
}

async function libreOffice(convert: () => Promise<Buffer>, what: string): Promise<Buffer> {
  try {
    return await convert()
  } catch(error) {
    if(error instanceof PdfConverterUnavailableError) throw new UploadReadError(`${ what } files can't be read on this server yet. Save the file as a PDF and upload that.`)
    throw new UploadReadError(`This ${ what } file couldn't be opened. Save it again (or as a PDF) and upload that.`)
  }
}

// One page sized to the image's shape (letter width, portrait or landscape), the image filling it.
async function imageToPdf(image: Buffer, kind: "png" | "jpeg"): Promise<Buffer> {
  try {
    const pdf = await PDFDocument.create()
    const embedded = kind === "png" ? await pdf.embedPng(image) : await pdf.embedJpg(image)
    const landscape = embedded.width > embedded.height
    const [maxW, maxH] = landscape ? [792, 612] : [612, 792]
    const scale = Math.min(maxW / embedded.width, maxH / embedded.height)
    const [w, h] = [embedded.width * scale, embedded.height * scale]
    pdf.addPage([w, h]).drawImage(embedded, { x: 0, y: 0, width: w, height: h })
    return Buffer.from(await pdf.save())
  } catch {
    throw new UploadReadError("This image couldn't be opened. Save it as a PDF or a standard JPEG and upload that.")
  }
}

// Pages a text document counts as against the tools' page caps: about one printed page's worth.
export const TEXT_PAGE_CHARS = 3000
export const textPages = (text: string): number => Math.max(1, Math.ceil(text.length / TEXT_PAGE_CHARS))

// How the read describes a workbook, for prompts that cite pages.
export const WORKBOOK_NOTE = "A document given as text is an Excel workbook: each sheet starts with a \"## Sheet N\" heading and each row reads \"R<row>: cell | cell | ...\". Cite it by sheet and row (e.g. \"Sheet 1, R12\") instead of a page. Numbers appear unformatted (e.g. 1000000 for $1,000,000; 0.02 may be 2%), so read limits and premiums as the document evidently means them."

export function documentBlock(doc: ReadableDoc, title: string): Anthropic.Beta.BetaRequestDocumentBlock {
  return doc.format === "pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: doc.data.toString("base64") }, title }
    : { type: "document", source: { type: "text", media_type: "text/plain", data: doc.data }, title }
}

// ---------- Excel → text ----------

// About 100k tokens; a workbook bigger than this is almost certainly a rating export or data dump.
const MAX_WORKBOOK_CHARS = 400_000

function cellText(value: ExcelJS.CellValue): string {
  if(value === null || value === undefined) return ""
  if(value instanceof Date) return value.toISOString().slice(0, 10)
  if(typeof value !== "object") return String(value)
  if("richText" in value) return value.richText.map((r) => r.text).join("")
  if("formula" in value || "sharedFormula" in value) return "result" in value && value.result !== undefined ? cellText(value.result as ExcelJS.CellValue) : ""
  if("text" in value) return String(value.text)
  return ""
}

export async function workbookText(file: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(file as unknown as ArrayBuffer)
  } catch {
    throw new UploadReadError("This Excel file couldn't be opened. Save it again as .xlsx and upload that.")
  }

  const sheets: string[] = []
  workbook.worksheets.forEach((sheet, i) => {
    const rows: string[] = []
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: string[] = []
      for(let c = 1; c <= row.cellCount; c++) {
        const cell = row.getCell(c)
        // A merged range repeats its value in every cell; keep it in the first one only.
        cells.push(cell.isMerged && cell.master.address !== cell.address ? "" : cellText(cell.value).replace(/\s+/g, " ").trim())
      }
      while(cells.length && !cells[cells.length - 1]) cells.pop()
      if(cells.some(Boolean)) rows.push(`R${ rowNumber }: ${ cells.join(" | ") }`)
    })
    if(rows.length) sheets.push(`## Sheet ${ i + 1 }: ${ sheet.name }${ sheet.state === "visible" ? "" : " (hidden)" }\n${ rows.join("\n") }`)
  })

  const text = sheets.join("\n\n")
  if(!text) throw new UploadReadError("This Excel file is empty.")
  if(text.length > MAX_WORKBOOK_CHARS) throw new UploadReadError("This Excel file has more detail than can be read in one pass. Remove the sheets that aren't needed and upload it again.")
  return text
}
