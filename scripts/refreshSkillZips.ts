// Rebuilds the per-skill .zip files at the repo root (policies.zip, customers.zip, etc.) from the
// current contents of src/skills/<name>/ — these zips are hand-distributed skill packages, easy to
// forget after editing a SKILL.md. Builds a standard (non-Zip64) ZIP archive by hand via node:zlib
// rather than pulling in a dependency (e.g. archiver) or shelling out to `zip` — this box doesn't
// have the `zip` binary installed, and every skill's contents are small text files.
//
// Usage: npx tsx scripts/refreshSkillZips.ts
// Refreshes every skill under src/skills/ that has a SKILL.md; skips any that don't.

import { crc32, deflateRawSync } from "node:zlib"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

const SKILLS_DIR = path.join(import.meta.dirname, "..", "src", "skills")
const REPO_ROOT = path.join(import.meta.dirname, "..")

function toDosDateTime(date: Date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f)
  const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f)
  return { time, date: dosDate }
}

function collectFiles(dir: string, arcBase: string): { arcname: string; absPath: string }[] {
  const results: { arcname: string; absPath: string }[] = []

  for(const entry of readdirSync(dir, { withFileTypes: true })) {
    const absPath = path.join(dir, entry.name)
    const arcname = `${ arcBase }/${ entry.name }`

    if(entry.isDirectory()) {
      results.push(...collectFiles(absPath, arcname))
    } else if(entry.isFile()) {
      results.push({ arcname, absPath })
    }
  }

  return results
}

function buildZip(files: { arcname: string; absPath: string }[]): Buffer {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0

  for(const file of files) {
    const data = readFileSync(file.absPath)
    const compressed = deflateRawSync(data)
    const checksum = crc32(data) as unknown as number
    const { time, date } = toDosDateTime(statSync(file.absPath).mtime)
    const nameBuf = Buffer.from(file.arcname, "utf8")

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(0, 6) // flags
    localHeader.writeUInt16LE(8, 8) // compression method: deflate
    localHeader.writeUInt16LE(time, 10)
    localHeader.writeUInt16LE(date, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28) // extra field length

    localChunks.push(localHeader, nameBuf, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0, 8) // flags
    centralHeader.writeUInt16LE(8, 10) // compression method: deflate
    centralHeader.writeUInt16LE(time, 12)
    centralHeader.writeUInt16LE(date, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra field length
    centralHeader.writeUInt16LE(0, 32) // comment length
    centralHeader.writeUInt16LE(0, 34) // disk number start
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
    centralHeader.writeUInt32LE(offset, 42) // local header offset

    centralChunks.push(centralHeader, nameBuf)

    offset += localHeader.length + nameBuf.length + compressed.length
  }

  const centralDirOffset = offset
  const centralDir = Buffer.concat(centralChunks)

  const endRecord = Buffer.alloc(22)
  endRecord.writeUInt32LE(0x06054b50, 0)
  endRecord.writeUInt16LE(0, 4) // disk number
  endRecord.writeUInt16LE(0, 6) // disk with central dir
  endRecord.writeUInt16LE(files.length, 8) // entries on this disk
  endRecord.writeUInt16LE(files.length, 10) // total entries
  endRecord.writeUInt32LE(centralDir.length, 12)
  endRecord.writeUInt32LE(centralDirOffset, 16)
  endRecord.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localChunks, centralDir, endRecord])
}

function main() {
  const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory())

  for(const dir of skillDirs) {
    const skillPath = path.join(SKILLS_DIR, dir.name)

    if(!statSync(path.join(skillPath, "SKILL.md"), { throwIfNoEntry: false })) {
      console.log(`[refreshSkillZips] skipping ${ dir.name } (no SKILL.md)`)
      continue
    }

    const files = collectFiles(skillPath, dir.name)
    const zipBuffer = buildZip(files)
    const outPath = path.join(REPO_ROOT, `${ dir.name }.zip`)

    writeFileSync(outPath, zipBuffer)
    console.log(`[refreshSkillZips] wrote ${ dir.name }.zip (${ files.length } file${ files.length === 1 ? "" : "s" }, ${ zipBuffer.length } bytes)`)
  }
}

main()
