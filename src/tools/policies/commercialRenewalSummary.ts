import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../../config/config.js"
import { runReadOnlyQuery } from "../../db.js"
import { storeDownload } from "../../utils/downloadStore.js"
import { sendMailWithAttachment } from "../../utils/mailer.js"
import { archiveRenewalSummary, sanitizeForFilename } from "../../utils/renewalSummaryArchive.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { logger } from "../../utils/logger.js"
import { fetchPolicyLobInfo } from "../../utils/policyLineOfBusiness.js"
import { money } from "../../utils/renewalSummaryDoc.js"
import type {
  DriverRow, EquipmentBlanket, EquipmentItemRow, GlExposureRow, LocationRow, PolicySummaryRow,
  PropertyRow, VehicleRow, WcExposureRow
} from "../../utils/renewalSummaryDoc.js"
import { buildRenewalSummaryDoc } from "../../utils/renewalSummaryDoc.js"

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// Same fallback chain download_report already uses for a customer that's a commercial/business
// entity — dba/firmnamecust is usually where the real business name lives, not lastname/firstname.
const CUSTOMER_NAME_EXPR = "COALESCE(c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''), c.firmnamecust)"

// typeofbus = 2 ("Commercial Lines", per afw_prcode AttrCode='TB') scopes this tool to commercial
// policies only — personal lines renewals have no exposure schedules to build here.
//
// Deliberately does NOT filter on renewalrptflag='A' (client-corrected 2026-09-14, Defatta Custom
// Homes LLC): a carrier/AMS360 can flip a term's renewalrptflag to 'R' the moment its successor term
// is bound, even weeks before that successor's poleffdate arrives — so for the whole window between
// "next year's term got written up" and "next year's term actually starts," the term that's
// genuinely in force today carries 'R', not 'A', while the 'A'-flagged successor hasn't started yet.
// Patrick's own words: "It should return data for the policies currently in force based on effective
// and expiration dates regardless of if they are market renewed or active." poleffdate <= now() <=
// polexpdate alone is both necessary AND sufficient to mean "in force today" — it already excludes a
// bound-but-not-yet-started renewal (poleffdate in the future) and an expired term not yet marked
// status='D' (polexpdate in the past), which is all the 2026-08-27 renewalrptflag='A' requirement
// was ever actually doing (see book_summary's CURRENT_POLICIES_CTE comment) — so dropping the flag
// condition here loses no real protection while fixing the Defatta-shaped gap.
// fulltermpremium feeds the cover-page policy-summary table when several matched policies get
// combined into one document (see below); its "type" column (Monoline/Package) comes separately
// from fetchPolicyLobInfo — NOT from polsubtype, which looks like a monoline/package flag by name
// but isn't one (see policyLineOfBusiness.ts's header comment).
const RESOLVE_POLICY_QUERY = `
  SELECT p.polid, p.polno, p.poleffdate, p.polexpdate, p.custid, p.csrcode,
    ${ CUSTOMER_NAME_EXPR } AS customer_name,
    co.name AS carrier_name,
    csr.email AS csr_email,
    COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), p.csrcode) AS csr_name,
    p.fulltermpremium
  FROM afw_basicpolinfo p
  LEFT JOIN afw_customer c ON c.custid = p.custid
  LEFT JOIN afw_company co ON co.cocode = p.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = p.csrcode
  WHERE p.typeofbus = 2
    AND p.polsubtype != 'S'
    AND p.status != 'D'
    AND p.poleffdate <= now()
    AND p.polexpdate >= now()
    AND ($1::text IS NULL OR (p.polno ILIKE $1 OR p.shortpolno ILIKE $1))
    AND ($2::uuid IS NULL OR p.custid = $2)
    -- Scopes a custid-only (or loosely-matched) lookup to policies actually renewing soon, e.g. "the
    -- next 3 months" — without this a customer with a large book (several lines of business, several
    -- years of history's worth of distinct current terms) would otherwise combine every one of their
    -- current commercial policies regardless of how far out its renewal is, which isn't what "give me
    -- their upcoming renewals" actually means. NULL (the default) keeps today's unscoped behavior.
    AND ($3::int IS NULL OR p.polexpdate <= now() + ($3::int * INTERVAL '1 day'))
  ORDER BY customer_name, p.polexpdate
  LIMIT 12
`

type ResolvedPolicy = {
  polid: string
  polno: string
  poleffdate: string
  polexpdate: string
  custid: string
  csrcode: string | null
  customer_name: string | null
  carrier_name: string | null
  csr_email: string | null
  csr_name: string | null
  fulltermpremium: string | number | null
}

// Every dedup query below follows the same convention as policyQuery.ts's includes: ROW_NUMBER()
// partitions over ALL rows for a key (no status filter inside the subquery), ordered by effdate
// DESC, and only the outer WHERE checks `rn = 1 AND status != 'D'`. This matters, not just style —
// filtering status != 'D' *before* ranking would pick the latest surviving non-deleted row even when
// a later 'D' row exists for that same key, silently resurrecting an entity whose real latest state
// is deleted. Confirmed live on this policy's own Locations Schedule: a location record (clocid
// 4230d1b0...) was superseded by a new clocid on 2025-11-01 and its old row marked deleted the same
// day — ranking after filtering out 'D' would have kept the stale copy anyway, producing a genuine
// duplicate location row in the finished document.
const NAMED_INSUREDS_QUERY = `
  SELECT t.namedins
  FROM (
    SELECT t.namedins, t.status,
      ROW_NUMBER() OVER (PARTITION BY t.polid, t.cniid ORDER BY t.effdate DESC) AS rn
    FROM afw_cnamedinsured t
    WHERE t.polid = $1
  ) t
  WHERE t.rn = 1 AND t.status != 'D' AND t.namedins IS NOT NULL AND TRIM(t.namedins) != ''
  ORDER BY t.namedins
`

// Two-stage dedup — NOT a single ROW_NUMBER partitioned by locno — because AMS360 doesn't always
// retire the old clocid when a location gets edited into a new one. Confirmed on Trace
// Construction's own property policy: locno 00001 carries FOUR distinct clocid values across its
// history, and two of them ("1804 Williamson Ct Ste 205", clocid 73b3c91c... and b1e5eb15...) are
// BOTH still status='A' at their own latest effdate — a real duplicate-active-record case, not the
// usual superseded-then-marked-D pattern this file's dedup convention normally relies on.
// Stage 1 (`active`) is the file's standard per-entity dedup, unchanged: collapse each clocid to
// its own latest version, keep it only if that version is still active. Stage 2 then collapses
// whatever clocid's survive stage 1 sharing the same locno down to just the most recently entered
// one. Doing this in one pass (partition directly by locno, rank by effdate across every clocid's
// every version) was tried and is wrong: locno 00001's single most-recent effdate row across ALL
// four clocid's turned out to belong to a clocid whose latest state is 'D' — rn=1 AND status!='D'
// then matches NOTHING for that locno, silently dropping a genuinely-current location instead of
// falling back to the next-most-recent active clocid.
const LOCATIONS_QUERY = `
  SELECT x.locno, x.addr1, x.addr2, x.city, x.state, x.zip
  FROM (
    SELECT active.*,
      ROW_NUMBER() OVER (PARTITION BY active.polid, active.locno ORDER BY active.effdate DESC) AS locno_rn
    FROM (
      SELECT t.polid, t.locno, t.addr1, t.addr2, t.city, t.state, t.zip, t.effdate
      FROM (
        SELECT t.*,
          ROW_NUMBER() OVER (PARTITION BY t.polid, t.clocid ORDER BY t.effdate DESC) AS rn
        FROM afw_clocation t
        WHERE t.polid = $1
      ) t
      WHERE t.rn = 1 AND t.status != 'D' AND t.locno IS NOT NULL
    ) active
  ) x
  WHERE x.locno_rn = 1
  ORDER BY x.locno
`

// afw_cprem.clocid is permanently unpopulated (confirmed 0/68 on a real commercial policy while
// originally planning this tool) — but that's NOT the real location link AMS360 uses for property
// coverage. The real chain, worked out jointly with a peer session digging into the live Vertafore
// Data Lake API schema (afw_logicaltable's tablename/basetable columns, not synced here until that
// investigation): afw_cprem.attachid (attachtype=320 = "140SubOfIns") -> afw_140subofins.soiid ->
// afw_140subofins.piid -> afw_140premiseinfo.piid -> afw_140premiseinfo.clocid -> afw_clocation.
// afw_140subofins.subofins ('Building' / 'Business Personal Property') is the Building-vs-BPP split
// itself, straight from source, not inferred from coverage text. Verified DB-wide post-backfill:
// attachid->soiid matches 20,353/20,353 (100%), and the full chain to a real address resolves
// 6,085/6,088 (99.95%) — the tiny remainder is a small number of policies where the same piid
// resolves to more than one clocid across a lobid quirk (not a dedup bug); not worth engineering
// around at that scale, per the same tolerance this file already applies elsewhere.
// afw_140subofins was previously on the ETL's NOT_AVAILABLE_VIA_API blocklist because the vendor API
// 500s when its `100percentval` column is requested — fixed and backfilled in ~/scripts/ams360-etl
// (a separate repo) once this link was discovered; 32,716 rows now synced.
// Join predicates are polid + the ID column only (no lobid equality) — confirmed empirically that
// requiring lobid match at either join step silently drops ~0.1-0.14% of otherwise-valid matches
// that AMS360 itself doesn't gate on lobid equality here.
const PROPERTY_QUERY = `
  WITH cprem_320 AS (
    SELECT * FROM (
      SELECT cp.*,
        ROW_NUMBER() OVER (PARTITION BY polid, lobid, cpremid ORDER BY effdate DESC) AS rn
      FROM afw_cprem cp
      WHERE attachtype = 320 AND polid = $1
    ) x WHERE rn = 1 AND status != 'D'
  ),
  soi AS (
    SELECT * FROM (
      SELECT s.*,
        ROW_NUMBER() OVER (PARTITION BY polid, lobid, soiid ORDER BY effdate DESC) AS rn
      FROM afw_140subofins s
      WHERE polid = $1
    ) x WHERE rn = 1 AND status != 'D' AND subofins IN ('Building', 'Business Personal Property')
  ),
  pi AS (
    SELECT * FROM (
      SELECT p.*,
        ROW_NUMBER() OVER (PARTITION BY polid, lobid, piid ORDER BY effdate DESC) AS rn
      FROM afw_140premiseinfo p
      WHERE polid = $1
    ) x WHERE rn = 1 AND status != 'D'
  ),
  loc AS (
    SELECT * FROM (
      SELECT c.*,
        ROW_NUMBER() OVER (PARTITION BY polid, clocid ORDER BY effdate DESC) AS rn
      FROM afw_clocation c
      WHERE polid = $1
    ) x WHERE rn = 1 AND status != 'D'
  )
  SELECT pi.piid, loc.addr1, loc.city, loc.state, loc.zip,
    soi.subofins, cprem_320.coverage, cprem_320.ilimit1, cprem_320.deduct
  FROM cprem_320
  JOIN soi ON soi.polid = cprem_320.polid AND soi.soiid = cprem_320.attachid
  JOIN pi ON pi.polid = soi.polid AND pi.piid = soi.piid
  JOIN loc ON loc.polid = pi.polid AND loc.clocid = pi.clocid
  ORDER BY pi.piid, (cprem_320.ilimit1 IS NULL), cprem_320.coverage
`

// afw_126shazard.classification is per-row free text AMS360 itself never standardizes — confirmed
// against real data it's inconsistently abbreviated (or, on the client's own reference document,
// simply not what AMS360's proposal-builder engine displays for the same class code) with no
// canonical description reachable anywhere in AMS360's own schema/API (joint investigation with the
// postgres-mcp and ams360-etl peer sessions, 2026-09-15: not a sync gap, this data was never part of
// AMS360's AFW_* relational schema at all — AFW_126SHazard.Classification's own field spec in the
// Design Guide documents it as sourced from "the ISO classification table or other standard industry
// table," i.e. licensed ISO/AAIS rating-engine content, structurally outside what the Data Lake API
// exposes). gl_classification_code is a standalone reference table (not afw_-prefixed, not synced
// AMS360 data) built from https://www.insurancexdate.com/gl.php (1,154 codes, pulled 2026-09-15) to
// fill this gap — LEFT JOINed here and preferred over the raw free text below when a match exists,
// falling back to it otherwise (a handful of class codes on any given policy may not appear in that
// external list). Client-reported 2026-09-15, Defatta Custom Homes LLC.
const GL_EXPOSURE_QUERY = `
  SELECT t.classcode, t.classification, t.prembasis, t.exposure,
    loc.addr1, loc.city, loc.state, loc.zip, gcc.description AS gl_description
  FROM (
    SELECT t.clocid, t.classcode, t.classification, t.prembasis, t.exposure, t.status,
      ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.shazid ORDER BY t.effdate DESC) AS rn
    FROM afw_126shazard t
    WHERE t.polid = $1
  ) t
  LEFT JOIN LATERAL (
    SELECT c.addr1, c.city, c.state, c.zip
    FROM afw_clocation c
    WHERE c.polid = $1 AND c.clocid = t.clocid AND c.status != 'D'
    ORDER BY c.effdate DESC LIMIT 1
  ) loc ON true
  LEFT JOIN gl_classification_code gcc ON gcc.classcode = t.classcode
  WHERE t.rn = 1 AND t.status != 'D'
  ORDER BY t.classcode
`

// 146equipsummary/146schedequip both key on a composite (polid, lobid, imefid, imesumid[, imseid])
// rather than a single own id — the PARTITION BY below must cover every part of that key or rows
// under-dedupe (confirmed against the live schema while planning this tool).
//
// Client-reported 2026-09-15 (Defatta Custom Homes LLC): the Blanket Summary section was missing
// Covered Location, Scheduled/Unscheduled, Coverage, and Deductible — all present on the client's
// own reference layout — because the original query only selected afw_146equipsummary's own plain
// columns. Three more joins fill these in, confirmed against real data:
//   - schedulecode ('M'/'S'/'U') resolves via afw_prcode's ISU AttrCode ("Scheduled Items, Not
//     Attached"/"Scheduled Items, Attached"/"Unscheduled") — same resolution pattern as prembasis's
//     PM AttrCode elsewhere in this file.
//   - imlocid links to afw_146locations (its OWN polid/lobid/imlocid/effdate-keyed row, same dedup
//     convention as everything else in this file), which usually has null addr1/city/state/zip of
//     its own but carries a clocid pointing back to afw_clocation for the real address — confirmed
//     on Defatta's own blanket record (imlocid resolves to clocid 0437eb33..., locno 00001, "110
//     Reynolds Rd").
//   - cpremid links directly to afw_cprem (the same coverage-line premium/rating table
//     PROPERTY_QUERY already uses) for Coverage (afw_cprem.coverage, e.g. "Fraud and Deceit") and
//     Deductible (afw_cprem.deduct) — deduped the same way PROPERTY_QUERY's cprem_320 CTE does,
//     since afw_cprem is a change history, not a snapshot.
const EQUIPMENT_BLANKET_QUERY = `
  SELECT t.category, t.totalitems, t.amtofins, schedule.description AS schedule_description,
    loc.addr1, loc.city, loc.state, loc.zip, prem.coverage, prem.deduct
  FROM (
    SELECT t.category, t.totalitems, t.amtofins, t.schedulecode, t.imlocid, t.cpremid, t.status,
      ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imefid, t.imesumid ORDER BY t.effdate DESC) AS rn
    FROM afw_146equipsummary t
    WHERE t.polid = $1
  ) t
  LEFT JOIN afw_prcode schedule ON rtrim(schedule.attrcode) = 'ISU' AND rtrim(schedule.code) = t.schedulecode
  LEFT JOIN LATERAL (
    SELECT COALESCE(il.addr1, cl.addr1) AS addr1, COALESCE(il.city, cl.city) AS city,
      COALESCE(il.state, cl.state) AS state, COALESCE(il.zip, cl.zip) AS zip
    FROM (
      SELECT il.*, ROW_NUMBER() OVER (PARTITION BY il.polid, il.lobid, il.imlocid ORDER BY il.effdate DESC) AS rn
      FROM afw_146locations il
      WHERE il.polid = $1 AND il.imlocid = t.imlocid
    ) il
    LEFT JOIN afw_clocation cl ON cl.polid = $1 AND cl.clocid = il.clocid AND cl.status != 'D'
    WHERE il.rn = 1 AND il.status != 'D'
    LIMIT 1
  ) loc ON true
  LEFT JOIN LATERAL (
    SELECT cp.coverage, cp.deduct
    FROM (
      SELECT cp.*, ROW_NUMBER() OVER (PARTITION BY cp.polid, cp.lobid, cp.cpremid ORDER BY cp.effdate DESC) AS rn
      FROM afw_cprem cp
      WHERE cp.polid = $1 AND cp.cpremid = t.cpremid
    ) cp
    WHERE cp.rn = 1 AND cp.status != 'D'
    LIMIT 1
  ) prem ON true
  WHERE t.rn = 1 AND t.status != 'D'
  ORDER BY (t.totalitems IS NOT NULL) DESC, (t.amtofins IS NOT NULL) DESC
  LIMIT 1
`

// Selects iinsamt, NOT value — value is almost always null tenant-wide (confirmed 4.6% populated,
// 205/4,453 non-deleted rows DB-wide) and where it IS populated looks like a stale placeholder
// pattern (equipdesc/serialno also null on those rows). iinsamt (plain integer) / vinsamt
// (pre-formatted string, e.g. "4,350") are the real populated fields (97.8%, 4,356/4,453) and are
// plain sibling columns on the same row — no join/link required, unlike Property Coverage's
// location link.
const EQUIPMENT_ITEMS_QUERY = `
  SELECT t.equipno, t.manufacturer, t.model, t.equipdesc, t.serialno, t.iinsamt
  FROM (
    SELECT t.equipno, t.manufacturer, t.model, t.equipdesc, t.serialno, t.iinsamt, t.status,
      ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imefid, t.imesumid, t.imseid ORDER BY t.effdate DESC) AS rn
    FROM afw_146schedequip t
    WHERE t.polid = $1
  ) t
  WHERE t.rn = 1 AND t.status != 'D'
  ORDER BY t.equipno
`

const VEHICLES_QUERY = `
  SELECT t.vehno, t.vehyear, t.make, t.model, t.vin
  FROM (
    SELECT t.vehno, t.vehyear, t.make, t.model, t.vin, t.status,
      ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.vehdid ORDER BY t.effdate DESC) AS rn
    FROM afw_127vehicle t
    WHERE t.polid = $1
  ) t
  WHERE t.rn = 1 AND t.status != 'D'
  ORDER BY t.vehno
`

// afw_127driver's schema does carry dob/licenseno/ssn columns, but they're locked down at the
// column-grant level for the claude role, which reflects Andrew's intentional decision to exclude
// PII from the replicated database — so they're deliberately left out of this SELECT rather than
// causing a permission-denied error. (A same-role information_schema.columns check will make it
// look like these columns don't exist at all, not merely inaccessible — Postgres only lists columns
// a role has some privilege on when that role isn't the table's owner. Confirmed via admin access
// that they're real columns, just invisible from claude's own seat — don't mistake that for the
// columns being absent if this ever needs re-checking.)
// datehired dropped per client feedback (9/13) — not shown in the finished doc, no need to select it.
const DRIVERS_QUERY = `
  SELECT t.driverno, t.name, t.licensestate
  FROM (
    SELECT t.driverno, t.name, t.licensestate, t.status,
      ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.drivid ORDER BY t.effdate DESC) AS rn
    FROM afw_127driver t
    WHERE t.polid = $1
  ) t
  WHERE t.rn = 1 AND t.status != 'D'
  ORDER BY t.driverno
`

// No location join per client feedback (9/13): "Don't have to have addresses for workers comp
// payroll. Just class codes and exposure." — dropped the afw_clocation LEFT JOIN LATERAL entirely
// since nothing else here needed it.
const WC_EXPOSURE_QUERY = `
  SELECT t.ratingclasscode, t.categories, t.vestannremun, t.iestannremun
  FROM (
    SELECT t.ratingclasscode, t.categories, t.vestannremun, t.iestannremun, t.status,
      ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.wratid ORDER BY t.effdate DESC) AS rn
    FROM afw_130rating t
    WHERE t.polid = $1
  ) t
  WHERE t.rn = 1 AND t.status != 'D'
  ORDER BY t.ratingclasscode
`

// AMS360 stores zip+4 as a single 9-digit string with no separator (e.g. "370272877") — reformatted
// to the standard 5+4 display ("37027-2877") when it's exactly 9 digits, left as-is otherwise.
function formatZip(zip: string | null): string {
  if(!zip) return ""
  const digits = zip.trim()
  return /^\d{9}$/.test(digits) ? `${ digits.slice(0, 5) }-${ digits.slice(5) }` : digits
}

// afw_clocation.locno comes back zero-padded (e.g. "00001") — stripped to its plain numeric form
// ("1") for display, per client feedback (2026-09-15). Only strips LEADING zeros immediately
// followed by another digit, so a bare "0" (if that ever occurs) is left alone rather than emptied,
// and a non-numeric locno (never seen in practice, but not guaranteed by the column's type) passes
// through unchanged since it won't start with "0<digit>" anyway.
function formatLocNo(locno: string): string {
  return locno.trim().replace(/^0+(?=\d)/, "")
}

function formatAddress(addr1: string | null, city: string | null, state: string | null, zip: string | null): string {
  const cityStateZip = [city, [state, formatZip(zip)].filter(Boolean).join(" ")].filter(Boolean).join(", ")
  return [addr1, cityStateZip].filter(Boolean).join(", ") || ""
}

function formatDate(value: string | null): string {
  return value ? value.slice(0, 10) : ""
}

// AMS360's synced §4.4.3 detail tables store several money-shaped fields as `text`, not `numeric` —
// confirmed against real data these show up two ways: a raw digit string ("40701000") or already
// comma-formatted ("110,000"), inconsistently, sometimes on the same table. Strips a leading "$" and
// any commas and reformats through money() when the result is a real number; otherwise falls back to
// the trimmed original text (AMS360 occasionally uses a non-numeric label here, e.g. "if any").
function numericMoney(raw: string | number | null | undefined): string {
  if(raw === null || raw === undefined || raw === "") return ""
  if(typeof raw === "number") return money(raw)

  const cleaned = raw.replace(/[$,]/g, "").trim()
  const num = Number(cleaned)

  return cleaned !== "" && Number.isFinite(num) ? money(num) : raw.trim()
}

// afw_126shazard.classification (and a couple of similar fixed-width AMS360 text columns) come back
// padded with trailing spaces in real data — trimmed for display.
function clean(value: string | null | undefined): string {
  return value?.trim() ?? ""
}

// afw_126shazard.prembasis is a single-letter code with no enumerated values documented on the
// column itself — the authoritative mapping lives in afw_prcode under AttrCode 'PM' ("PremBasis"),
// confirmed as an exact 7-for-7 match against every distinct prembasis value seen DB-wide, and
// consistent with the standard ISO CGL premium-basis code set. afw_prcode is a flat static
// reference table (no effdate/status), so this is hardcoded here rather than queried live.
const PREM_BASIS_LABELS: Record<string, string> = {
  A: "Area", C: "Total cost", S: "Gross sales", P: "Payroll", T: "Other", M: "Admissions", U: "Unit"
}

function premBasisLabel(code: string | null): string {
  const trimmed = clean(code)
  return PREM_BASIS_LABELS[trimmed] ?? trimmed
}

// Some Scheduled Items rows have manufacturer/model missing from AMS360's own dedicated columns
// even though the same information is right there in equipdesc's free text (e.g. "2024 Land Pride
// AP-HD74LLC Bucket S/N:2257570" with manufacturer/model both null) — confirmed a real data-entry
// inconsistency at the source (afw_146schedequip.manufacturer/model genuinely null, not a sync
// issue), not something recoverable via a different column or join. Patrick's own reference
// document has this same set of rows filled in — by hand, reading the description himself — which
// this reproduces automatically but conservatively: only ever matches a manufacturer name that
// ALREADY appears elsewhere in this SAME item list (never invents an unrecognized brand), and only
// accepts the token right after it as a model if that token contains a digit — real model codes in
// this data always do ("AP-HD74LLC", "Z970R", "KX057-5R3AP"), whereas a plain descriptive word that
// isn't actually a model ("Pallet" in "Land Pride Pallet Forks") never does. Patrick's own document
// left that exact row's model blank too, for the same reason — this only fills in what can be
// matched with high confidence, never guesses.
function inferMissingEquipmentDetails(rows: EquipmentItemRow[]): EquipmentItemRow[] {
  const knownManufacturers = [...new Set(rows.map((r) => r.manufacturer).filter(Boolean))]
    .sort((a, b) => b.length - a.length)

  return rows.map((row) => {
    if(row.model !== "") return row

    // Tier 1: a manufacturer name already confirmed elsewhere in this SAME item list, matched
    // anywhere in the description (handles both "2024 Land Pride AP-HD74LLC Bucket S/N:..." and
    // "Bucket, Land Pride AP-HD80LLC, Serial #:..." — different word order, same known brand).
    for(const mfg of knownManufacturers) {
      const idx = row.description.indexOf(mfg)
      if(idx === -1) continue

      const rest = row.description.slice(idx + mfg.length).trimStart()
      const nextToken = rest.split(/\s+/)[0]?.replace(/[,.;]+$/, "") ?? ""

      if(nextToken !== "" && /\d/.test(nextToken)) {
        return { ...row, manufacturer: row.manufacturer || mfg, model: nextToken }
      }
    }

    // Tier 2 fallback: no known brand matched (e.g. "Kubota" never happens to appear on an
    // already-populated row in this batch) — only used when the description starts with a literal
    // 4-digit year, a strong enough structural signal on its own that what follows is
    // "year manufacturer-word(s) model ..." rather than open-ended free text. Deliberately does NOT
    // apply without that year anchor — "Power Unit F6L914 S/N:8945208" has the same
    // words-then-digit-token shape but no year prefix, and "Power Unit" isn't a real manufacturer;
    // Patrick's own reference document left that row's manufacturer blank too.
    const yearMatch = row.description.match(/^\d{4}\s+/)
    if(yearMatch) {
      const words = row.description.slice(yearMatch[0].length).split(/\s+/)
      const mfgWords: string[] = []
      let modelCandidate = ""

      for(const w of words) {
        if(/^[A-Z][A-Za-z]*$/.test(w)) { mfgWords.push(w); continue }
        modelCandidate = w.replace(/[,.;]+$/, "")
        break
      }

      if(mfgWords.length > 0 && modelCandidate !== "" && /\d/.test(modelCandidate)) {
        return { ...row, manufacturer: row.manufacturer || mfgWords.join(" "), model: modelCandidate }
      }
    }

    return row
  })
}

type PropertyQueryRow = {
  piid: string; addr1: string | null; city: string | null; state: string | null; zip: string | null
  subofins: string; coverage: string | null; ilimit1: number | null; deduct: number | null
}

// Groups PROPERTY_QUERY's per-coverage-line rows into one row per premise/address. Building and BPP
// limits are summed separately (subofins tells us which); Causes of Loss Form and Deductible are
// shared per address rather than split by subofins, matching the client's own reference layout. When
// an address carries more than one distinct coverage form (e.g. a Special Form building limit plus a
// separate Wind/Hail deductible line), each form is called out by name in the Deductible column
// rather than collapsed into one figure, since a bare number would misstate which deductible applies
// to which peril.
function buildPropertyRows(rows: PropertyQueryRow[]): PropertyRow[] {
  const groups = new Map<string, PropertyQueryRow[]>()
  for(const r of rows) {
    const list = groups.get(r.piid)
    if(list) list.push(r); else groups.set(r.piid, [r])
  }

  return [...groups.values()].map((groupRows) => {
    const first = groupRows[0]
    const address = formatAddress(first.addr1, first.city, first.state, first.zip)

    const sumLimit = (subofins: string) => {
      const matching = groupRows.filter((r) => r.subofins === subofins && r.ilimit1 !== null)
      return matching.length === 0 ? "N/A" : money(matching.reduce((sum, r) => sum + (r.ilimit1 ?? 0), 0))
    }

    // Distinct coverage forms across BOTH Building and BPP rows for this address, in first-seen
    // order — Causes of Loss Form/Deductible are shared columns, not split by subofins.
    const formOrder: string[] = []
    const deductByForm = new Map<string, number>()
    for(const r of groupRows) {
      const form = clean(r.coverage)
      if(!form) continue
      if(!formOrder.includes(form)) formOrder.push(form)
      if(r.deduct !== null && !deductByForm.has(form)) deductByForm.set(form, r.deduct)
    }

    const deductible = formOrder.length <= 1
      ? (formOrder.length === 1 && deductByForm.has(formOrder[0]) ? money(deductByForm.get(formOrder[0])!) : "")
      : formOrder.filter((f) => deductByForm.has(f)).map((f) => `${ money(deductByForm.get(f)!) } (${ f })`).join("; ")

    return {
      address,
      buildingLimit: sumLimit("Building"),
      bppLimit: sumLimit("Business Personal Property"),
      causesOfLossForm: formOrder.join("; "),
      deductible,
      description: ""
    }
  })
}

type PolicyData = {
  namedInsuredNames: string[]
  locations: LocationRow[]
  property: PropertyRow[]
  glExposure: GlExposureRow[]
  equipmentBlanket: EquipmentBlanket | null
  equipmentItems: EquipmentItemRow[]
  vehicles: VehicleRow[]
  drivers: DriverRow[]
  wcExposure: WcExposureRow[]
}

// Runs the full set of per-policy section queries and maps them to doc-builder row shapes, with no
// named-insureds/client-name filtering applied yet — that happens once in the caller after every
// matched policy's data is in hand, so a single-policy call and a combined multi-policy call (see
// registerCommercialRenewalSummaryTool below) share this exact same mapping.
async function fetchPolicyData(policy: ResolvedPolicy): Promise<PolicyData> {
  const [
    namedInsuredRows, locationRows, propertyRows, glRows,
    equipmentBlanketRows, equipmentItemRows, vehicleRows, driverRows, wcRows
  ] = await Promise.all([
    runReadOnlyQuery(NAMED_INSUREDS_QUERY, [policy.polid]) as Promise<{ namedins: string }[]>,
    runReadOnlyQuery(LOCATIONS_QUERY, [policy.polid]) as Promise<{ locno: string; addr1: string | null; addr2: string | null; city: string | null; state: string | null; zip: string | null }[]>,
    runReadOnlyQuery(PROPERTY_QUERY, [policy.polid]) as Promise<PropertyQueryRow[]>,
    runReadOnlyQuery(GL_EXPOSURE_QUERY, [policy.polid]) as Promise<{ classcode: string | null; classification: string | null; prembasis: string | null; exposure: string | null; addr1: string | null; city: string | null; state: string | null; zip: string | null; gl_description: string | null }[]>,
    runReadOnlyQuery(EQUIPMENT_BLANKET_QUERY, [policy.polid]) as Promise<{ category: string | null; totalitems: string | null; amtofins: string | null; schedule_description: string | null; addr1: string | null; city: string | null; state: string | null; zip: string | null; coverage: string | null; deduct: number | null }[]>,
    runReadOnlyQuery(EQUIPMENT_ITEMS_QUERY, [policy.polid]) as Promise<{ equipno: string | null; manufacturer: string | null; model: string | null; equipdesc: string | null; serialno: string | null; iinsamt: number | null }[]>,
    runReadOnlyQuery(VEHICLES_QUERY, [policy.polid]) as Promise<{ vehno: string | null; vehyear: string | null; make: string | null; model: string | null; vin: string | null }[]>,
    runReadOnlyQuery(DRIVERS_QUERY, [policy.polid]) as Promise<{ driverno: string | null; name: string | null; licensestate: string | null }[]>,
    runReadOnlyQuery(WC_EXPOSURE_QUERY, [policy.polid]) as Promise<{ ratingclasscode: string | null; categories: string | null; vestannremun: string | null; iestannremun: number | null }[]>
  ])

  return {
    namedInsuredNames: namedInsuredRows.map((r) => r.namedins.trim()),
    locations: locationRows.map((l) => ({
      locNo: formatLocNo(l.locno),
      address: [l.addr1, l.addr2].filter(Boolean).join(" "),
      city: l.city ?? "",
      state: l.state ?? "",
      zip: formatZip(l.zip)
    })),
    property: buildPropertyRows(propertyRows),
    glExposure: glRows.map((g) => ({
      location: formatAddress(g.addr1, g.city, g.state, g.zip),
      classCode: clean(g.classcode),
      classification: clean(g.gl_description) || clean(g.classification),
      basis: premBasisLabel(g.prembasis),
      exposure: numericMoney(g.exposure)
    })),
    equipmentBlanket: equipmentBlanketRows.length > 0
      ? {
          coveredLocation: formatAddress(equipmentBlanketRows[0].addr1, equipmentBlanketRows[0].city, equipmentBlanketRows[0].state, equipmentBlanketRows[0].zip),
          category: clean(equipmentBlanketRows[0].category),
          scheduledUnscheduled: clean(equipmentBlanketRows[0].schedule_description),
          coverage: clean(equipmentBlanketRows[0].coverage),
          amountOfInsurance: numericMoney(equipmentBlanketRows[0].amtofins),
          totalItems: clean(equipmentBlanketRows[0].totalitems) || "0",
          deductible: equipmentBlanketRows[0].deduct !== null ? money(equipmentBlanketRows[0].deduct) : ""
        }
      : null,
    equipmentItems: inferMissingEquipmentDetails(equipmentItemRows.map((e) => ({
      itemNo: clean(e.equipno),
      manufacturer: clean(e.manufacturer),
      model: clean(e.model),
      description: clean(e.equipdesc),
      serialNo: clean(e.serialno),
      value: money(e.iinsamt)
    }))),
    vehicles: vehicleRows.map((v) => ({
      vehNo: clean(v.vehno),
      year: clean(v.vehyear),
      make: clean(v.make),
      model: clean(v.model),
      vin: clean(v.vin)
    })),
    drivers: driverRows.map((d) => ({
      driverNo: clean(d.driverno),
      name: clean(d.name),
      licenseState: clean(d.licensestate)
    })),
    wcExposure: wcRows.map((w) => ({
      classCode: clean(w.ratingclasscode),
      classification: clean(w.categories),
      payroll: w.iestannremun !== null ? money(w.iestannremun) : numericMoney(w.vestannremun)
    }))
  }
}

export function registerCommercialRenewalSummaryTool(server: McpServer) {
  server.registerTool(
    "commercial_renewal_summary",
    {
      description: "Builds a branded \"Pre-Renewal Review\" Word document (.docx) for one or more commercial-lines policies — the current expiring program's exposure schedules (Named Insureds, Locations, Property Coverage, General Liability Exposure, Equipment, Vehicles, Drivers, Workers' Comp Exposure), for the CSR and client to review together ahead of the renewal. Called ad hoc (not tied to download_report) — pass polno and/or custid to identify the policy/policies. Commercial lines only (typeofbus=2); resolves to the customer's current in-force term(s) (poleffdate/polexpdate bracketing today — not the renewalrptflag column, which can lag behind a term already bound early for next year). Sections with no data are omitted entirely rather than shown empty. The General Liability and Workers' Comp tables carry an intentionally blank \"Renewal Exposure\"/\"Renewal Payroll\" column for the live meeting — never populate these. Property Coverage is one row per address (Building Limit / BPP Limit split columns, plus a blank \"Description\" column for staff to annotate by hand at the renewal meeting) — not policy-wide coverage lines. MULTIPLE POLICIES IN ONE DOCUMENT: if the polno/custid filters resolve to more than one current commercial policy for the SAME customer (e.g. custid alone, or a polno fragment matching several of that customer's policies), they're combined into a single .docx instead of erroring — one cover page with a policy summary table (policy #, type, premium, renewal date) replacing the single current-period/renewal-date line, and Named Insureds merged and deduped across policies (up to 12 policies at once). Every other section's rows are simply combined with no per-row \"Policy #\" tag, since in practice each section's data only ever comes from one of the combined policies anyway. If the filters instead match several policies across DIFFERENT customers (an ambiguous polno with no custid), that's treated as ambiguous as before — no document is built; narrow with a more specific polno or add custid. By default the finished document is emailed to the policy's CSR (resolved from csrcode) and a 24-hour download link is also returned; pass send_email=false to skip the email and just get the link, or override_recipient to send to a specific address (e.g. for testing) instead of the real CSR — when combining policies that resolve to more than one distinct CSR, override_recipient becomes required (no single real CSR to default to). Every generated document is also archived to scripts/output/cl-renewal-summaries/ (kept 30 days) with a manifest.json entry (csr_code, csr_name, client_name, polno, carrier_name, generated_at, renewal_date) that backs the CSR-grouped renewal-summaries index page — at most one archived file per policy (polid) at a time, or per exact combined policy set — regenerating the same single policy, or the same combination of policies, overwrites its own prior copy rather than accumulating.",
      inputSchema: {
        polno: z.string().describe("Partial match against policy number or short policy number — narrows to one customer's current, in-force commercial policy/policies (combine with custid to disambiguate if needed). Matching more than one policy for the same customer combines them into one document; matching across different customers is treated as ambiguous.").optional(),
        custid: z.string().uuid().describe("Filter to a specific customer's current commercial policy/policies — with no polno, ALL of that customer's current commercial policies (optionally further scoped by renewal_within_days) are combined into one document").optional(),
        renewal_within_days: z.number().int().positive().describe("Only include policies whose renewal (polexpdate) falls within this many days from today — e.g. 90 for \"renewing over the next 3 months.\" Use this to scope a combined document to the policies actually renewing soon rather than every current commercial policy the customer has, which can include lines of business (e.g. a Workers' Comp or Employee Benefits policy still coded typeofbus=2) irrelevant to the renewal conversation at hand. Omit for no date scoping (today's default).").optional(),
        send_email: z.boolean().default(true).describe("Email the finished .docx to the policy's CSR. When false, only a download link is returned — useful for a quick preview without notifying the CSR."),
        cc: z.array(z.string().email()).describe("Additional email addresses to CC alongside the CSR").optional(),
        override_recipient: z.string().email().describe("Send to this address INSTEAD of the policy's CSR — use for testing/QA so a real CSR doesn't get a test email. Ignored if send_email is false.").optional()
      }
    },
    async ({ polno, custid, renewal_within_days, send_email, cc, override_recipient }) => {
      try {
        if(!polno && !custid) {
          return errorResult(new Error("Pass at least one of polno or custid to identify the commercial policy"))
        }

        const polnoParam = polno ? `%${ polno }%` : null
        const custidParam = custid ?? null
        const renewalWindowParam = renewal_within_days ?? null

        const matches = await runReadOnlyQuery(RESOLVE_POLICY_QUERY, [polnoParam, custidParam, renewalWindowParam]) as ResolvedPolicy[]

        if(matches.length === 0) {
          return errorResult(new Error("No matching current, in-force commercial policy found for those filters. Check the policy is commercial lines (not personal), currently in force (poleffdate <= today <= polexpdate), and that polno/custid are correct."))
        }

        const distinctCustomers = new Set(matches.map((m) => m.custid))

        // Several matches across DIFFERENT customers means the filters were genuinely ambiguous
        // (e.g. a polno fragment with no custid) — that's still an error, same as before. Several
        // matches for the SAME customer, though, is exactly the "combine into one document" case
        // below, not an error.
        if(matches.length > 1 && distinctCustomers.size > 1) {
          return textResult({
            message: `${ matches.length } commercial policies matched across ${ distinctCustomers.size } different customers — narrow with a more specific polno or add custid.`,
            matches: matches.map((m) => ({
              customer_name: m.customer_name, polno: m.polno, carrier_name: m.carrier_name, csr_name: m.csr_name
            }))
          })
        }

        const combining = matches.length > 1
        const primaryPolicy = matches[0]
        const clientName = primaryPolicy.customer_name?.trim() || "[NOT PROVIDED — PLEASE CONFIRM]"

        const perPolicyData = await Promise.all(matches.map((policy) => fetchPolicyData(policy)))

        // Named insureds merged and deduped (case-insensitive) across every combined policy — a
        // single policy still goes through this same path (perPolicyData has just one entry), so
        // there's only one code path to keep correct rather than two.
        const namedInsuredsSeen = new Map<string, string>()
        for(const data of perPolicyData) {
          for(const rawName of data.namedInsuredNames) {
            if(rawName.toLowerCase() === clientName.toLowerCase()) continue
            const key = rawName.toLowerCase()
            if(!namedInsuredsSeen.has(key)) namedInsuredsSeen.set(key, rawName)
          }
        }
        const additionalNamedInsureds = [...namedInsuredsSeen.values()]

        // No per-row "Policy #" tagging — every section's rows only ever come from one of the
        // combined policies in practice (Property/GL from the property policy, Vehicles/Drivers from
        // auto, etc.), so a source-policy column would be pure noise. The cover-page policy summary
        // table below is still the reader's guide to what's combined.
        //
        // Locations Schedule is the one exception where that "only comes from one policy" premise
        // breaks down: every monoline policy records at least its own copy of the customer's primary
        // address (confirmed on Trace Construction: the Property policy's full 7-location schedule
        // PLUS a redundant standalone "1804 Williamson Ct" row from each of the other 3 combined
        // policies — WC, Auto, and a 4th line).
        //
        // Deduped by locNo, NOT by normalized address text (client-reported 2026-09-15, Defatta
        // Custom Homes LLC): confirmed against real data that AMS360 keeps locno consistent for the
        // same physical location across a customer's separate monoline policies (all three of
        // Defatta's combined policies carry locno='00001' for their shared primary address), but each
        // monoline policy's OWN copy of that location's address text can differ slightly — Defatta's
        // Property policy has "110-112 Reynolds Rd" (zip 37064) while its other two policies both
        // have "110 Reynolds Rd" (zip 37064-2926). Deduping on address text left two "Loc # 1" rows
        // with different addresses in the finished document; locNo is the stable, shared identifier
        // that actually says "this is the same location." When two policies' copies of the same
        // locNo disagree on address text, the longer (more complete) one wins, since a fuller street
        // address is more useful to the reader than a shorter/older copy.
        const locationsSeen = new Map<string, LocationRow>()
        for(const data of perPolicyData) {
          for(const loc of data.locations) {
            const key = loc.locNo.trim().toLowerCase()
            const existing = locationsSeen.get(key)
            if(!existing || loc.address.length > existing.address.length) locationsSeen.set(key, loc)
          }
        }
        const locations = [...locationsSeen.values()].sort((a, b) => {
          const na = Number(a.locNo)
          const nb = Number(b.locNo)
          if(Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
          return a.locNo.localeCompare(b.locNo)
        })

        const property = matches.flatMap((_, i) => perPolicyData[i].property)
        const glExposure = matches.flatMap((_, i) => perPolicyData[i].glExposure)
        const equipmentItems = matches.flatMap((_, i) => perPolicyData[i].equipmentItems)
        const vehicles = matches.flatMap((_, i) => perPolicyData[i].vehicles)
        const drivers = matches.flatMap((_, i) => perPolicyData[i].drivers)
        const wcExposure = matches.flatMap((_, i) => perPolicyData[i].wcExposure)

        const equipmentBlanket = matches.flatMap((_, i) => {
          const blanket = perPolicyData[i].equipmentBlanket
          return blanket ? [blanket] : []
        })

        // Only fetched when actually combining — the single-policy path (the vast majority of
        // calls) has no policy-summary table to populate, so skips this extra query entirely.
        const lobClassifications = combining
          ? await Promise.all(matches.map((policy) => fetchPolicyLobInfo(policy.polid)))
          : []

        const policySummary: PolicySummaryRow[] | undefined = combining
          ? matches.map((policy, i) => ({
              polNo: policy.polno,
              type: lobClassifications[i].classification || "—",
              premium: numericMoney(policy.fulltermpremium),
              renewalDate: formatDate(policy.polexpdate)
            }))
          : undefined

        const { buffer, includedSections } = await buildRenewalSummaryDoc({
          clientName,
          additionalNamedInsureds,
          currentPeriod: `${ formatDate(primaryPolicy.poleffdate) } – ${ formatDate(primaryPolicy.polexpdate) }`,
          renewalDate: formatDate(primaryPolicy.polexpdate),
          policySummary,
          locations,
          property,
          glExposure,
          equipmentBlanket,
          equipmentItems,
          vehicles,
          drivers,
          wcExposure
        })

        const polnoLabel = matches.map((m) => m.polno).join(", ")
        const filename = combining
          ? `${ sanitizeForFilename(clientName) }_Pre-Renewal_Review_Combined.docx`
          : `${ sanitizeForFilename(clientName) }_Pre-Renewal_Review.docx`
        const token = storeDownload(buffer, filename, DOCX_MIME_TYPE)
        const downloadUrl = `${ publicBaseUrl }/downloads/${ token }`

        // Keyed by polid (this specific policy TERM), not custid alone — a customer can carry
        // several distinct commercial policies at once (confirmed against real data: Celebration
        // Homes LLC has 4), and keying only by custid collapsed all of them onto a single file,
        // each regeneration silently overwriting a different policy's packet. polid is unique per
        // term, so: regenerating the SAME term (same policy, same renewal date) still overwrites
        // its own prior copy, a different policy for the same customer gets its own separate file,
        // and a future renewal of this same policy (a new term, new polid, new renewal_date once
        // AMS360 processes it) becomes its own new file rather than clobbering this one. A combined
        // document is instead keyed on the full set of matched polnos, so regenerating the exact
        // same combination overwrites its own prior copy, and a different combination (e.g. a 6th
        // policy added later) gets its own separate file rather than clobbering this one.
        const archiveFilename = combining
          ? `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(matches.map((m) => m.polno).join("_")) }_combined.docx`
          : `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(primaryPolicy.polno) }_${ primaryPolicy.polid }.docx`

        // A combined document sorts by the SOONEST of its included renewal dates, matching the
        // index page's "soonest-due renewal first" intent for a single policy.
        const earliestRenewalDate = matches.reduce((earliest, m) => (m.polexpdate < earliest ? m.polexpdate : earliest), primaryPolicy.polexpdate)

        archiveRenewalSummary(buffer, {
          filename: archiveFilename,
          generated_at: new Date().toISOString(),
          csr_code: primaryPolicy.csrcode,
          csr_name: primaryPolicy.csr_name,
          client_name: clientName,
          polno: polnoLabel,
          carrier_name: primaryPolicy.carrier_name,
          renewal_date: formatDate(earliestRenewalDate)
        })

        let emailStatus = "Not sent (send_email=false)."

        if(send_email) {
          const distinctCsrEmails = new Set(matches.map((m) => m.csr_email).filter((e): e is string => !!e))

          if(!override_recipient && combining && distinctCsrEmails.size > 1) {
            emailStatus = `Not sent — the combined policies resolve to ${ distinctCsrEmails.size } different CSRs; pass override_recipient to choose one, or send_email=false to just get the link.`
          } else {
            const recipient = override_recipient ?? primaryPolicy.csr_email

            if(!recipient) {
              emailStatus = `Not sent — no email on file for CSR ${ primaryPolicy.csr_name ?? primaryPolicy.csrcode ?? "(unassigned)" }.`
            } else {
              await sendMailWithAttachment({
                to: cc && cc.length > 0 ? [recipient, ...cc] : recipient,
                subject: `Boxwood Pre-Renewal Review — ${ clientName }`,
                text: combining
                  ? `Attached is the combined Pre-Renewal Review for ${ clientName } (policies ${ polnoLabel }).`
                  : `Attached is the Pre-Renewal Review for ${ clientName } (policy ${ primaryPolicy.polno }), ahead of the ${ formatDate(primaryPolicy.polexpdate) } renewal.`,
                attachment: { filename, content: buffer, contentType: DOCX_MIME_TYPE }
              })
              emailStatus = override_recipient
                ? `Emailed to ${ recipient } (override — CSR ${ primaryPolicy.csr_name ?? primaryPolicy.csrcode ?? "unassigned" } was NOT emailed).`
                : `Emailed to ${ primaryPolicy.csr_name ?? recipient } (${ recipient }).`
            }
          }
        }

        return textResult({
          message: combining
            ? `Built the combined Pre-Renewal Review for ${ clientName } (${ matches.length } policies: ${ polnoLabel }) — ${ includedSections.length } section(s) included: ${ includedSections.join(", ") }. ${ emailStatus }`
            : `Built the Pre-Renewal Review for ${ clientName } (policy ${ primaryPolicy.polno }) — ${ includedSections.length } section(s) included: ${ includedSections.join(", ") }. ${ emailStatus }`,
          download_url: downloadUrl,
          included_sections: includedSections
        })
      } catch(error) {
        logger.error({ err: error, polno, custid, send_email }, "commercial_renewal_summary failed")
        return errorResult(error)
      }
    }
  )
}
