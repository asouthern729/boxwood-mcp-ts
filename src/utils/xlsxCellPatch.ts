import JSZip from "jszip"

export type NumericCellEdit = { ref: string; value: number }

export type PatchNumericCellsResult = {
  buffer: Buffer
  applied: string[]
  // Refs whose <c> element doesn't exist in the sheet XML at all — reported, never inserted, since a
  // missing cell element means the sheet no longer has the shape the caller assumed.
  missing: string[]
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function resolveSheetPath(zip: JSZip, sheetIndex: number): Promise<string> {
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string")
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string")
  if(!workbookXml || !relsXml) throw new Error("Not an .xlsx package (missing xl/workbook.xml or its rels)")

  const sheetTags = workbookXml.match(/<sheet\b[^>]*>/g) ?? []
  const sheetTag = sheetTags[sheetIndex - 1]
  const relId = sheetTag?.match(/\br:id="([^"]+)"/)?.[1]
  if(!relId) throw new Error(`Workbook has no sheet #${ sheetIndex }`)

  const relTag = (relsXml.match(/<Relationship\b[^>]*>/g) ?? []).find((tag) => tag.includes(`Id="${ relId }"`))
  const target = relTag?.match(/\bTarget="([^"]+)"/)?.[1]
  if(!target) throw new Error(`No relationship target for sheet #${ sheetIndex } (${ relId })`)

  // Targets are relative to xl/ unless absolute (leading "/" = package root).
  return target.startsWith("/") ? target.slice(1) : `xl/${ target }`
}

export type CellReading =
  | { kind: "blank" }
  | { kind: "number"; value: number }
  // Text (shared/inline string) — its plain text, rich-text runs concatenated.
  | { kind: "text"; text: string }
  // Anything else: a formula, boolean, error — never something Refresh treats as its own.
  | { kind: "other" }

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_all, entity: string) =>
    entity.startsWith("#x") ? String.fromCodePoint(parseInt(entity.slice(2), 16))
    : entity.startsWith("#") ? String.fromCodePoint(Number(entity.slice(1)))
    : XML_ENTITIES[entity])
}

// Plain text of an <si>/<is> string item — every <t> run concatenated (skipping phonetic <rPh> runs).
function stringItemText(itemXml: string): string {
  const withoutPhonetic = itemXml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")
  return [...withoutPhonetic.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)].map((m) => unescapeXml(m[1] ?? "")).join("")
}

function findCellElement(sheetXml: string, ref: string): string | null {
  // Matches either <c r="E12" .../> or <c r="E12" ...>...</c> — [^>]* can't cross a tag boundary,
  // so a non-self-closing open tag can never be mistaken for the self-closing form.
  const cellPattern = new RegExp(`<c\\b[^>]*\\br="${ escapeRegExp(ref) }"[^>]*?(?:/>|>[\\s\\S]*?</c>)`)
  return sheetXml.match(cellPattern)?.[0] ?? null
}

function readCellElement(cellXml: string | null, sharedStrings: string[]): CellReading {
  if(!cellXml) return { kind: "blank" }
  const openTag = cellXml.match(/^<c\b[^>]*?(?=\/?>)/)![0]
  const type = openTag.match(/\bt="([^"]*)"/)?.[1] ?? "n"
  if(/<f\b/.test(cellXml)) return { kind: "other" }

  let text: string | null = null
  if(type === "inlineStr") {
    text = stringItemText(cellXml.match(/<is\b[\s\S]*?<\/is>/)?.[0] ?? "")
  } else {
    const raw = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1]
    if(raw === undefined) return { kind: "blank" }
    if(type === "s") text = sharedStrings[Number(raw)] ?? ""
    else if(type === "n") {
      const value = Number(raw)
      return Number.isFinite(value) ? { kind: "number", value } : { kind: "other" }
    } else return { kind: "other" }
  }

  return text === "" ? { kind: "blank" } : { kind: "text", text }
}

// Reads specific cells straight from the package XML — no ExcelJS load, which throws outright on
// some workbooks another app (Excel, openpyxl) has saved, exactly the files this needs to handle.
export async function readCells(buffer: Buffer, sheetIndex: number, refs: string[]): Promise<Map<string, CellReading>> {
  const zip = await JSZip.loadAsync(buffer)
  const sheetXml = await zip.file(await resolveSheetPath(zip, sheetIndex))!.async("string")
  const sharedStringsXml = await zip.file("xl/sharedStrings.xml")?.async("string")
  const sharedStrings = (sharedStringsXml?.match(/<si\b[\s\S]*?<\/si>|<si\/>/g) ?? []).map(stringItemText)

  return new Map(refs.map((ref) => [ref, readCellElement(findCellElement(sheetXml, ref), sharedStrings)]))
}

// Writes plain numeric values into specific, already-existing cells of an .xlsx WITHOUT
// re-serializing the workbook. Only the target sheet's XML (each target <c> element, nothing else in
// it) and xl/workbook.xml's <calcPr> (fullCalcOnLoad, so dependent formulas like Percent Change and
// TOTAL recalculate on open) are touched — every other part of the package (shared strings, styles,
// comments/notes, drawings, anything Excel or an employee added) keeps its exact content (the zip
// itself is recompressed, but every other entry's uncompressed bytes are unchanged). This is
// deliberately NOT ExcelJS's read→write round-trip, which rebuilds the whole package and can drop
// features it doesn't model once a human has edited and saved the file in Excel.
export async function patchNumericCells(buffer: Buffer, sheetIndex: number, edits: NumericCellEdit[]): Promise<PatchNumericCellsResult> {
  const zip = await JSZip.loadAsync(buffer)
  const sheetPath = await resolveSheetPath(zip, sheetIndex)
  let sheetXml = await zip.file(sheetPath)!.async("string")

  const applied: string[] = []
  const missing: string[] = []

  for(const { ref, value } of edits) {
    if(!Number.isFinite(value)) throw new Error(`Refusing to write non-finite value to ${ ref }`)

    const cellXml = findCellElement(sheetXml, ref)
    if(!cellXml) {
      missing.push(ref)
      continue
    }

    // Keeps the cell's style index; drops t= (shared/inline string type) so the new <v> is read as
    // a number.
    const openTag = cellXml.match(/^<c\b[^>]*?(?=\/?>)/)![0]
    const style = openTag.match(/\bs="(\d+)"/)?.[1]
    const replacement = `<c r="${ ref }"${ style !== undefined ? ` s="${ style }"` : "" }><v>${ value }</v></c>`
    sheetXml = sheetXml.replace(cellXml, () => replacement)
    applied.push(ref)
  }

  if(applied.length === 0) return { buffer, applied, missing }

  zip.file(sheetPath, sheetXml)

  const workbookXml = await zip.file("xl/workbook.xml")!.async("string")
  // Only when <calcPr> already exists (Excel and ExcelJS both always write one) — inserting a new one
  // would have to respect the schema's element order, not worth the risk for a recalc hint.
  if(/<calcPr\b/.test(workbookXml)) {
    zip.file("xl/workbook.xml", workbookXml.replace(/<calcPr\b([^>]*?)(\/?)>/, (_all, attrs: string, selfClose: string) =>
      `<calcPr${ attrs.replace(/\s*\bfullCalcOnLoad="[^"]*"/, "") } fullCalcOnLoad="1"${ selfClose }>`))
  }

  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  return { buffer: out, applied, missing }
}
