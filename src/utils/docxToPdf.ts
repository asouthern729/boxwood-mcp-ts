import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// Word → PDF for the tool pages' "Download PDF" (Patrick, 2026-09-29: "Ability to download pdf from
// the tool page"), via headless LibreOffice, so the PDF is the same document as the .docx rather than
// a second layout to keep in sync. Needs `libreoffice-writer-nogui` plus the metric-compatible font
// packages (fonts-crosextra-carlito for Calibri, fonts-liberation2 for Arial) installed on the box —
// without those fonts LibreOffice substitutes and the layout shifts.
const SOFFICE_CANDIDATES = ["/usr/bin/soffice", "/usr/lib/libreoffice/program/soffice"]
const CONVERT_TIMEOUT_MS = 90_000

export class PdfConverterUnavailableError extends Error {}

function sofficePath(): string {
  const found = SOFFICE_CANDIDATES.find((candidate) => existsSync(candidate))
  if(!found) throw new PdfConverterUnavailableError("PDF conversion isn't available on this server yet (LibreOffice is not installed).")
  return found
}

// Converts a .docx file on disk and caches the PDF beside it (same basename, .pdf); a cached PDF is
// reused until the .docx is regenerated (newer mtime). Each conversion gets its own throwaway
// LibreOffice profile directory, since two conversions sharing the default profile lock each other.
export async function pdfForDocx(docxPath: string): Promise<{ buffer: Buffer; filename: string }> {
  const pdfPath = docxPath.replace(/\.docx$/i, ".pdf")
  const filename = path.basename(pdfPath)

  if(existsSync(pdfPath) && statSync(pdfPath).mtimeMs >= statSync(docxPath).mtimeMs) {
    return { buffer: readFileSync(pdfPath), filename }
  }

  const buffer = await convertDocxToPdf(readFileSync(docxPath))
  writeFileSync(pdfPath, buffer)
  return { buffer, filename }
}

// The conversion itself, for a .docx that isn't archived (the Proposal Builder reads an uploaded
// AMS360 proposal as a PDF so its tables keep their layout; uploaded Word documents are read the
// same way, uploadNormalize.ts).
export async function convertDocxToPdf(docx: Buffer): Promise<Buffer> {
  return convertWithLibreOffice(docx, "docx", "pdf")
}

// An old binary Excel workbook (.xls) to .xlsx, so it's read like any other workbook
// (uploadNormalize.ts). Needs `libreoffice-calc-nogui` on the box.
export async function convertXlsToXlsx(xls: Buffer): Promise<Buffer> {
  return convertWithLibreOffice(xls, "xls", "xlsx")
}

async function convertWithLibreOffice(input: Buffer, fromExt: string, toExt: string): Promise<Buffer> {
  const soffice = sofficePath()
  const workDir = mkdtempSync(path.join(tmpdir(), `${ fromExt }2${ toExt }-`))

  try {
    const inputPath = path.join(workDir, `document.${ fromExt }`)
    writeFileSync(inputPath, input)
    await execFileAsync(soffice, [
      `-env:UserInstallation=file://${ path.join(workDir, "profile") }`,
      "--headless", "--norestore", "--convert-to", toExt, "--outdir", workDir, inputPath
    ], { timeout: CONVERT_TIMEOUT_MS })

    const output = path.join(workDir, `document.${ toExt }`)
    if(!existsSync(output)) throw new Error(`LibreOffice finished without producing a .${ toExt }`)

    return readFileSync(output)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
