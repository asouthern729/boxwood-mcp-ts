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

// ---------- Row-level sheet editing (PL Renewal Calculator) ----------
//
// Same no-ExcelJS, patch-the-XML approach as patchNumericCells above, for a template that needs more
// than numbers written: labels, formulas with cached values, and whole blocks of cells cleared. Edits
// work on a row's cell list rather than on individual <c> strings, so a cell that doesn't exist yet is
// inserted in column order and a cleared range simply drops its cells — which is only safe because
// callers that clear or rewrite formula cells also drop calcChain.xml (Excel rebuilds it silently) and
// never leave a shared-formula follower (<f t="shared" si=".."/>) behind without its master.

export type CellEdit =
  | { kind: "number"; value: number; style?: string }
  | { kind: "text"; text: string; style?: string }
  // Index into the workbook's existing sharedStrings.xml — reuses the template's own strings.
  | { kind: "shared"; index: number; style?: string }
  // A plain (non-shared) formula plus the value Excel would compute for it, so previews that don't
  // recalculate (Outlook, OneDrive thumbnails, client-side xlsx parsers) still show real numbers.
  | { kind: "formula"; formula: string; cached: number | { error: string } | string; style?: string }
  | { kind: "blank"; style?: string }

export type SheetEditor = {
  set: (ref: string, edit: CellEdit) => void
  // Removes every cell in rows fromRow..toRow whose column falls in fromCol..toCol (letters).
  clear: (fromRow: number, toRow: number, fromCol: string, toCol: string) => void
  // Keeps an existing formula cell's <f> exactly (e.g. structured table references) and replaces only
  // its cached result; a non-finite value is cached as #DIV/0!. Throws if the cell has no formula.
  setCachedValue: (ref: string, value: number) => void
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function columnNumber(letters: string): number {
  return [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
}

function splitRef(ref: string): { col: string; row: number } {
  const match = ref.match(/^([A-Z]+)(\d+)$/)
  if(!match) throw new Error(`Bad cell reference ${ ref }`)
  return { col: match[1], row: Number(match[2]) }
}

function cellXml(ref: string, edit: CellEdit): string {
  const s = edit.style !== undefined ? ` s="${ edit.style }"` : ""
  switch(edit.kind) {
    case "number":
      if(!Number.isFinite(edit.value)) throw new Error(`Refusing to write non-finite value to ${ ref }`)
      return `<c r="${ ref }"${ s }><v>${ edit.value }</v></c>`
    case "text":
      return `<c r="${ ref }"${ s } t="inlineStr"><is><t xml:space="preserve">${ escapeXml(edit.text) }</t></is></c>`
    case "shared":
      return `<c r="${ ref }"${ s } t="s"><v>${ edit.index }</v></c>`
    case "formula": {
      const f = `<f>${ escapeXml(edit.formula) }</f>`
      if(typeof edit.cached === "number") {
        return Number.isFinite(edit.cached) ? `<c r="${ ref }"${ s }>${ f }<v>${ edit.cached }</v></c>` : `<c r="${ ref }"${ s } t="e">${ f }<v>#DIV/0!</v></c>`
      }
      if(typeof edit.cached === "string") return `<c r="${ ref }"${ s } t="str">${ f }<v>${ escapeXml(edit.cached) }</v></c>`
      return `<c r="${ ref }"${ s } t="e">${ f }<v>${ escapeXml(edit.cached.error) }</v></c>`
    }
    case "blank":
      return `<c r="${ ref }"${ s }/>`
  }
}

type ParsedRow = { open: string; cells: { col: string; xml: string }[] }

function parseRow(rowXml: string): ParsedRow {
  const open = rowXml.match(/^<row\b[^>]*?(?=\/?>)/)![0]
  const cells = [...rowXml.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)].map((m) => ({
    col: m[0].match(/\br="([A-Z]+)\d+"/)![1],
    xml: m[0]
  }))
  return { open, cells }
}

function renderRow(row: ParsedRow): string {
  const sorted = [...row.cells].sort((a, b) => columnNumber(a.col) - columnNumber(b.col))
  // spans is only an optimisation hint; dropping it is always valid and avoids it going stale.
  const open = row.open.replace(/\s+spans="[^"]*"/, "")
  return sorted.length ? `${ open }>${ sorted.map((c) => c.xml).join("") }</row>` : `${ open }/>`
}

// Applies `edit` to one sheet of an .xlsx and returns the new package. Every other part is left
// untouched except: calcChain.xml (always dropped, with its rel and content-type override, since
// edits can move or remove formula cells) and workbook.xml's calcPr (fullCalcOnLoad="1").
export async function editSheet(buffer: Buffer, sheetIndex: number, edit: (sheet: SheetEditor) => void): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer)
  const sheetPath = await resolveSheetPath(zip, sheetIndex)
  let sheetXml = await zip.file(sheetPath)!.async("string")

  const rows = new Map<number, ParsedRow>()
  for(const m of sheetXml.matchAll(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
    const rowNumber = Number(m[0].match(/\br="(\d+)"/)![1])
    rows.set(rowNumber, parseRow(m[0]))
  }

  function rowOf(rowNumber: number): ParsedRow {
    let row = rows.get(rowNumber)
    if(!row) {
      row = { open: `<row r="${ rowNumber }"`, cells: [] }
      rows.set(rowNumber, row)
    }
    return row
  }

  const editor: SheetEditor = {
    set(ref, cellEdit) {
      const { col, row: rowNumber } = splitRef(ref)
      const row = rowOf(rowNumber)
      const existing = row.cells.find((c) => c.col === col)
      // Default to the template cell's own style, so a value lands with the template's formatting.
      const style = cellEdit.style ?? existing?.xml.match(/^<c\b[^>]*?\bs="(\d+)"/)?.[1]
      const xml = cellXml(ref, { ...cellEdit, style } as CellEdit)
      if(existing) existing.xml = xml
      else row.cells.push({ col, xml })
    },
    setCachedValue(ref, value) {
      const { col, row: rowNumber } = splitRef(ref)
      const existing = rows.get(rowNumber)?.cells.find((c) => c.col === col)
      const formula = existing?.xml.match(/<f\b[\s\S]*?(?:<\/f>|\/>)/)?.[0]
      if(!existing || !formula) throw new Error(`No formula cell at ${ ref } to cache a value on`)
      const style = existing.xml.match(/^<c\b[^>]*?\bs="(\d+)"/)?.[1]
      const s = style !== undefined ? ` s="${ style }"` : ""
      existing.xml = Number.isFinite(value)
        ? `<c r="${ ref }"${ s }>${ formula }<v>${ value }</v></c>`
        : `<c r="${ ref }"${ s } t="e">${ formula }<v>#DIV/0!</v></c>`
    },
    clear(fromRow, toRow, fromCol, toCol) {
      const lo = columnNumber(fromCol)
      const hi = columnNumber(toCol)
      for(let r = fromRow; r <= toRow; r++) {
        const row = rows.get(r)
        if(row) row.cells = row.cells.filter((c) => columnNumber(c.col) < lo || columnNumber(c.col) > hi)
      }
    }
  }

  edit(editor)

  const rendered = [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => renderRow(row)).join("")
  sheetXml = sheetXml.replace(/<sheetData\b[^>]*?(?:\/>|>[\s\S]*?<\/sheetData>)/, () => `<sheetData>${ rendered }</sheetData>`)
  zip.file(sheetPath, sheetXml)

  const workbookXml = await zip.file("xl/workbook.xml")!.async("string")
  if(/<calcPr\b/.test(workbookXml)) {
    zip.file("xl/workbook.xml", workbookXml.replace(/<calcPr\b([^>]*?)(\/?)>/, (_all, attrs: string, selfClose: string) =>
      `<calcPr${ attrs.replace(/\s*\bfullCalcOnLoad="[^"]*"/, "") } fullCalcOnLoad="1"${ selfClose }>`))
  }

  if(zip.file("xl/calcChain.xml")) {
    zip.remove("xl/calcChain.xml")
    const relsXml = await zip.file("xl/_rels/workbook.xml.rels")!.async("string")
    zip.file("xl/_rels/workbook.xml.rels", relsXml.replace(/<Relationship\b[^>]*calcChain[^>]*\/>/g, ""))
    const typesXml = await zip.file("[Content_Types].xml")!.async("string")
    zip.file("[Content_Types].xml", typesXml.replace(/<Override\b[^>]*calcChain[^>]*\/>/g, ""))
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}
