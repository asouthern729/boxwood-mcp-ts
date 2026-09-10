import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"
import { publicBaseUrl } from "../../config/config.js"
import { runReadOnlyQuery } from "../../db.js"
import { storeDownload } from "../../utils/downloadStore.js"
import { sendMailWithAttachment } from "../../utils/mailer.js"
import { archiveRenewalSummary, sanitizeForFilename } from "../../utils/renewalSummaryArchive.js"
import { errorResult, textResult } from "../../utils/mcpHelpers.js"
import { logger } from "../../utils/logger.js"
import { money } from "../../utils/renewalSummaryDoc.js"
import type {
  DriverRow, EquipmentBlanket, EquipmentItemRow, GlExposureRow, LocationRow, PropertyRow,
  VehicleRow, WcExposureRow
} from "../../utils/renewalSummaryDoc.js"
import { buildRenewalSummaryDoc } from "../../utils/renewalSummaryDoc.js"

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// Same fallback chain download_report already uses for a customer that's a commercial/business
// entity — dba/firmnamecust is usually where the real business name lives, not lastname/firstname.
const CUSTOMER_NAME_EXPR = "COALESCE(c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''), c.firmnamecust)"

// typeofbus = 2 ("Commercial Lines", per afw_prcode AttrCode='TB') scopes this tool to commercial
// policies only — personal lines renewals have no exposure schedules to build here. renewalrptflag
// = 'A' plus the poleffdate/polexpdate bounds is the same "genuinely in force today" filter
// policy_query/upcoming_renewals/book_summary all standardize on, not the raw `status` column.
const RESOLVE_POLICY_QUERY = `
  SELECT p.polid, p.polno, p.poleffdate, p.polexpdate, p.custid, p.csrcode,
    ${ CUSTOMER_NAME_EXPR } AS customer_name,
    co.name AS carrier_name,
    csr.email AS csr_email,
    COALESCE(NULLIF(TRIM(CONCAT_WS(' ', csr.firstname, csr.lastname)), ''), p.csrcode) AS csr_name
  FROM afw_basicpolinfo p
  LEFT JOIN afw_customer c ON c.custid = p.custid
  LEFT JOIN afw_company co ON co.cocode = p.cocode
  LEFT JOIN afw_employee csr ON csr.empcode = p.csrcode
  WHERE p.typeofbus = 2
    AND p.renewalrptflag = 'A'
    AND p.polsubtype != 'S'
    AND p.status != 'D'
    AND p.poleffdate <= now()
    AND p.polexpdate >= now()
    AND ($1::text IS NULL OR (p.polno ILIKE $1 OR p.shortpolno ILIKE $1))
    AND ($2::uuid IS NULL OR p.custid = $2)
  ORDER BY customer_name
  LIMIT 6
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

const LOCATIONS_QUERY = `
  SELECT t.locno, t.addr1, t.addr2, t.city, t.state, t.zip
  FROM (
    SELECT t.locno, t.addr1, t.addr2, t.city, t.state, t.zip, t.status,
      ROW_NUMBER() OVER (PARTITION BY t.polid, t.clocid ORDER BY t.effdate DESC) AS rn
    FROM afw_clocation t
    WHERE t.polid = $1
  ) t
  WHERE t.rn = 1 AND t.status != 'D' AND t.locno IS NOT NULL
  ORDER BY t.locno
`

// afw_cprem carries no reliable row-level link back to a specific afw_clocation in this tenant's
// synced data (confirmed: clocid populated on ~0.5% of rows tenant-wide, 0/68 on a real commercial
// policy checked while planning this tool) — so this is presented policy-wide, one row per coverage
// line, rather than grouped by address. `lineofbus` lives on afw_lineofbusiness, not afw_cprem
// itself, hence the join; afw_lineofbusiness has no `status` column, so no dedup on that side.
// Filtered to rows carrying an actual limit or deductible (same "has a limit or deductible value"
// rule download_report's COVERAGE_CHANGE_QUERY already uses) to drop administrative/premium-only
// rows (e.g. bare "Terrorism Coverage" endorsement markers with no $ figure of their own).
const PROPERTY_QUERY = `
  SELECT t.coverage, t.formscond, t.ilimit1, t.deduct, t.coinspct
  FROM (
    SELECT t.coverage, t.formscond, t.ilimit1, t.deduct, t.coinspct, t.status,
      ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.cpremid ORDER BY t.effdate DESC) AS rn
    FROM afw_cprem t
    JOIN afw_lineofbusiness l ON l.lobid = t.lobid AND l.polid = t.polid
    WHERE t.polid = $1 AND l.lineofbus = 'PROP'
  ) t
  WHERE t.rn = 1 AND t.status != 'D' AND (t.ilimit1 IS NOT NULL OR t.deduct IS NOT NULL)
  ORDER BY t.formscond, t.coverage
`

const GL_EXPOSURE_QUERY = `
  SELECT t.classcode, t.classification, t.prembasis, t.exposure,
    loc.addr1, loc.city, loc.state, loc.zip
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
  WHERE t.rn = 1 AND t.status != 'D'
  ORDER BY t.classcode
`

// 146equipsummary/146schedequip both key on a composite (polid, lobid, imefid, imesumid[, imseid])
// rather than a single own id — the PARTITION BY below must cover every part of that key or rows
// under-dedupe (confirmed against the live schema while planning this tool).
const EQUIPMENT_BLANKET_QUERY = `
  SELECT t.category, t.subcategory, t.totalitems, t.amtofins, t.coinspct
  FROM (
    SELECT t.category, t.subcategory, t.totalitems, t.amtofins, t.coinspct, t.status,
      ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imefid, t.imesumid ORDER BY t.effdate DESC) AS rn
    FROM afw_146equipsummary t
    WHERE t.polid = $1
  ) t
  WHERE t.rn = 1 AND t.status != 'D'
  ORDER BY (t.totalitems IS NOT NULL) DESC, (t.amtofins IS NOT NULL) DESC
  LIMIT 1
`

const EQUIPMENT_ITEMS_QUERY = `
  SELECT t.equipno, t.manufacturer, t.model, t.equipdesc, t.serialno, t.value
  FROM (
    SELECT t.equipno, t.manufacturer, t.model, t.equipdesc, t.serialno, t.value, t.status,
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

// afw_127driver's schema does carry dob/licenseno columns, but they're locked down at the column-
// grant level for the claude role — same PII convention as afw_applicant/afw_driver (see project
// memory) — so they're deliberately left out of this SELECT rather than causing a permission-denied
// error.
const DRIVERS_QUERY = `
  SELECT t.driverno, t.name, t.licensestate, t.datehired
  FROM (
    SELECT t.driverno, t.name, t.licensestate, t.datehired, t.status,
      ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.drivid ORDER BY t.effdate DESC) AS rn
    FROM afw_127driver t
    WHERE t.polid = $1
  ) t
  WHERE t.rn = 1 AND t.status != 'D'
  ORDER BY t.driverno
`

const WC_EXPOSURE_QUERY = `
  SELECT t.ratingclasscode, t.categories, t.vestannremun, t.iestannremun,
    loc.addr1, loc.city, loc.state, loc.zip
  FROM (
    SELECT t.clocid, t.ratingclasscode, t.categories, t.vestannremun, t.iestannremun, t.status,
      ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.wratid ORDER BY t.effdate DESC) AS rn
    FROM afw_130rating t
    WHERE t.polid = $1
  ) t
  LEFT JOIN LATERAL (
    SELECT c.addr1, c.city, c.state, c.zip
    FROM afw_clocation c
    WHERE c.polid = $1 AND c.clocid = t.clocid AND c.status != 'D'
    ORDER BY c.effdate DESC LIMIT 1
  ) loc ON true
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

export function registerCommercialRenewalSummaryTool(server: McpServer) {
  server.registerTool(
    "commercial_renewal_summary",
    {
      description: "Builds a branded \"Pre-Renewal Review\" Word document (.docx) for one commercial-lines policy — the current expiring program's exposure schedules (Named Insureds, Locations, Property Coverage, General Liability Exposure, Equipment, Vehicles, Drivers, Workers' Comp Exposure), for the CSR and client to review together ahead of the renewal. Called ad hoc (not tied to download_report) — pass polno and/or custid to identify the policy. Commercial lines only (typeofbus=2); resolves to the customer's current in-force term (renewalrptflag='A'). Sections with no data for this client are omitted entirely rather than shown empty. The General Liability and Workers' Comp tables carry an intentionally blank \"Renewal Exposure\"/\"Renewal Payroll\" column for the live meeting — never populate these. IMPORTANT: Property Coverage is listed policy-wide, not grouped by address like some older reference documents show — AMS360's synced coverage-line data (afw_cprem) has no reliable link back to a specific location in this tenant's data, so per-address grouping isn't possible here. By default the finished document is emailed to the policy's CSR (resolved from csrcode) and a 24-hour download link is also returned; pass send_email=false to skip the email and just get the link, or override_recipient to send to a specific address (e.g. for testing) instead of the real CSR. Every generated document is also archived to scripts/output/cl-renewal-summaries/ (kept 30 days) with a manifest.json entry (csr_code, csr_name, client_name, polno, carrier_name, generated_at, renewal_date) that backs the CSR-grouped renewal-summaries index page — at most one archived file per policy (polid) at a time — a customer with several distinct commercial policies gets one file per policy, and regenerating the same policy's packet overwrites its own prior copy rather than accumulating.",
      inputSchema: {
        polno: z.string().describe("Partial match against policy number or short policy number — must resolve to exactly one current, in-force commercial policy (combine with custid to disambiguate if needed)").optional(),
        custid: z.string().uuid().describe("Filter to a specific customer's current commercial policy").optional(),
        send_email: z.boolean().default(true).describe("Email the finished .docx to the policy's CSR. When false, only a download link is returned — useful for a quick preview without notifying the CSR."),
        cc: z.array(z.string().email()).describe("Additional email addresses to CC alongside the CSR").optional(),
        override_recipient: z.string().email().describe("Send to this address INSTEAD of the policy's CSR — use for testing/QA so a real CSR doesn't get a test email. Ignored if send_email is false.").optional()
      }
    },
    async ({ polno, custid, send_email, cc, override_recipient }) => {
      try {
        if(!polno && !custid) {
          return errorResult(new Error("Pass at least one of polno or custid to identify the commercial policy"))
        }

        const polnoParam = polno ? `%${ polno }%` : null
        const custidParam = custid ?? null

        const matches = await runReadOnlyQuery(RESOLVE_POLICY_QUERY, [polnoParam, custidParam]) as ResolvedPolicy[]

        if(matches.length === 0) {
          return errorResult(new Error("No matching current, in-force commercial policy found for those filters. Check the policy is commercial lines (not personal), currently in force (renewalrptflag='A'), and that polno/custid are correct."))
        }

        if(matches.length > 1) {
          return textResult({
            message: `${ matches.length } commercial policies matched — narrow with a more specific polno or add custid.`,
            matches: matches.map((m) => ({
              customer_name: m.customer_name, polno: m.polno, carrier_name: m.carrier_name, csr_name: m.csr_name
            }))
          })
        }

        const policy = matches[0]

        const [
          namedInsuredRows, locationRows, propertyRows, glRows,
          equipmentBlanketRows, equipmentItemRows, vehicleRows, driverRows, wcRows
        ] = await Promise.all([
          runReadOnlyQuery(NAMED_INSUREDS_QUERY, [policy.polid]) as Promise<{ namedins: string }[]>,
          runReadOnlyQuery(LOCATIONS_QUERY, [policy.polid]) as Promise<{ locno: string; addr1: string | null; addr2: string | null; city: string | null; state: string | null; zip: string | null }[]>,
          runReadOnlyQuery(PROPERTY_QUERY, [policy.polid]) as Promise<{ coverage: string | null; formscond: string | null; ilimit1: number | null; deduct: number | null; coinspct: string | null }[]>,
          runReadOnlyQuery(GL_EXPOSURE_QUERY, [policy.polid]) as Promise<{ classcode: string | null; classification: string | null; prembasis: string | null; exposure: string | null; addr1: string | null; city: string | null; state: string | null; zip: string | null }[]>,
          runReadOnlyQuery(EQUIPMENT_BLANKET_QUERY, [policy.polid]) as Promise<{ category: string | null; subcategory: string | null; totalitems: string | null; amtofins: string | null; coinspct: string | null }[]>,
          runReadOnlyQuery(EQUIPMENT_ITEMS_QUERY, [policy.polid]) as Promise<{ equipno: string | null; manufacturer: string | null; model: string | null; equipdesc: string | null; serialno: string | null; value: string | null }[]>,
          runReadOnlyQuery(VEHICLES_QUERY, [policy.polid]) as Promise<{ vehno: string | null; vehyear: string | null; make: string | null; model: string | null; vin: string | null }[]>,
          runReadOnlyQuery(DRIVERS_QUERY, [policy.polid]) as Promise<{ driverno: string | null; name: string | null; licensestate: string | null; datehired: string | null }[]>,
          runReadOnlyQuery(WC_EXPOSURE_QUERY, [policy.polid]) as Promise<{ ratingclasscode: string | null; categories: string | null; vestannremun: string | null; iestannremun: number | null; addr1: string | null; city: string | null; state: string | null; zip: string | null }[]>
        ])

        const clientName = policy.customer_name?.trim() || "[NOT PROVIDED — PLEASE CONFIRM]"

        const additionalNamedInsureds = namedInsuredRows
          .map((r) => r.namedins.trim())
          .filter((name) => name.toLowerCase() !== clientName.toLowerCase())

        const locations: LocationRow[] = locationRows.map((l) => ({
          locNo: l.locno,
          address: [l.addr1, l.addr2].filter(Boolean).join(" "),
          city: l.city ?? "",
          state: l.state ?? "",
          zip: formatZip(l.zip)
        }))

        const property: PropertyRow[] = propertyRows.map((p) => ({
          subjectOfInsurance: clean(p.formscond),
          coverage: clean(p.coverage),
          limit: money(p.ilimit1),
          deductible: money(p.deduct),
          coinsurance: clean(p.coinspct)
        }))

        const glExposure: GlExposureRow[] = glRows.map((g) => ({
          location: formatAddress(g.addr1, g.city, g.state, g.zip),
          classCode: clean(g.classcode),
          classification: clean(g.classification),
          basis: clean(g.prembasis),
          exposure: numericMoney(g.exposure)
        }))

        const equipmentBlanket: EquipmentBlanket | null = equipmentBlanketRows.length > 0
          ? {
              category: clean(equipmentBlanketRows[0].category),
              subcategory: clean(equipmentBlanketRows[0].subcategory),
              totalItems: clean(equipmentBlanketRows[0].totalitems),
              amountOfInsurance: numericMoney(equipmentBlanketRows[0].amtofins),
              coinsurance: clean(equipmentBlanketRows[0].coinspct)
            }
          : null

        const equipmentItems: EquipmentItemRow[] = equipmentItemRows.map((e) => ({
          itemNo: clean(e.equipno),
          manufacturer: clean(e.manufacturer),
          model: clean(e.model),
          description: clean(e.equipdesc),
          serialNo: clean(e.serialno),
          value: numericMoney(e.value)
        }))

        const vehicles: VehicleRow[] = vehicleRows.map((v) => ({
          vehNo: clean(v.vehno),
          year: clean(v.vehyear),
          make: clean(v.make),
          model: clean(v.model),
          vin: clean(v.vin)
        }))

        const drivers: DriverRow[] = driverRows.map((d) => ({
          driverNo: clean(d.driverno),
          name: clean(d.name),
          licenseState: clean(d.licensestate),
          dateHired: formatDate(d.datehired)
        }))

        const wcExposure: WcExposureRow[] = wcRows.map((w) => ({
          location: formatAddress(w.addr1, w.city, w.state, w.zip),
          classCode: clean(w.ratingclasscode),
          classification: clean(w.categories),
          payroll: w.iestannremun !== null ? money(w.iestannremun) : numericMoney(w.vestannremun)
        }))

        const { buffer, includedSections } = await buildRenewalSummaryDoc({
          clientName,
          additionalNamedInsureds,
          currentPeriod: `${ formatDate(policy.poleffdate) } – ${ formatDate(policy.polexpdate) }`,
          renewalDate: formatDate(policy.polexpdate),
          locations,
          property,
          glExposure,
          equipmentBlanket,
          equipmentItems,
          vehicles,
          drivers,
          wcExposure
        })

        const filename = `${ sanitizeForFilename(clientName) }_Pre-Renewal_Review.docx`
        const token = storeDownload(buffer, filename, DOCX_MIME_TYPE)
        const downloadUrl = `${ publicBaseUrl }/downloads/${ token }`

        // Keyed by polid (this specific policy TERM), not custid alone — a customer can carry
        // several distinct commercial policies at once (confirmed against real data: Celebration
        // Homes LLC has 4), and keying only by custid collapsed all of them onto a single file,
        // each regeneration silently overwriting a different policy's packet. polid is unique per
        // term, so: regenerating the SAME term (same policy, same renewal date) still overwrites
        // its own prior copy, a different policy for the same customer gets its own separate file,
        // and a future renewal of this same policy (a new term, new polid, new renewal_date once
        // AMS360 processes it) becomes its own new file rather than clobbering this one.
        const archiveFilename = `${ sanitizeForFilename(clientName) }_${ sanitizeForFilename(policy.polno) }_${ policy.polid }.docx`
        archiveRenewalSummary(buffer, {
          filename: archiveFilename,
          generated_at: new Date().toISOString(),
          csr_code: policy.csrcode,
          csr_name: policy.csr_name,
          client_name: clientName,
          polno: policy.polno,
          carrier_name: policy.carrier_name,
          renewal_date: formatDate(policy.polexpdate)
        })

        let emailStatus = "Not sent (send_email=false)."

        if(send_email) {
          const recipient = override_recipient ?? policy.csr_email

          if(!recipient) {
            emailStatus = `Not sent — no email on file for CSR ${ policy.csr_name ?? policy.csrcode ?? "(unassigned)" }.`
          } else {
            await sendMailWithAttachment({
              to: cc && cc.length > 0 ? [recipient, ...cc] : recipient,
              subject: `Boxwood Pre-Renewal Review — ${ clientName }`,
              text: `Attached is the Pre-Renewal Review for ${ clientName } (policy ${ policy.polno }), ahead of the ${ formatDate(policy.polexpdate) } renewal.`,
              attachment: { filename, content: buffer, contentType: DOCX_MIME_TYPE }
            })
            emailStatus = override_recipient
              ? `Emailed to ${ recipient } (override — CSR ${ policy.csr_name ?? policy.csrcode ?? "unassigned" } was NOT emailed).`
              : `Emailed to ${ policy.csr_name ?? recipient } (${ recipient }).`
          }
        }

        return textResult({
          message: `Built the Pre-Renewal Review for ${ clientName } (policy ${ policy.polno }) — ${ includedSections.length } section(s) included: ${ includedSections.join(", ") }. ${ emailStatus }`,
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
