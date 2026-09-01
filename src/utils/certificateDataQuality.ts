// AMS360 has template/placeholder certificate holder records polluting real data — confirmed
// 4 variants (case and letter-spacing differ: "SAMPLE CERT", "SAMPLE CERTIFICATE",
// "S A M P L E  C E R T I F I C A T E", "S A M P L E   C E R T I F I C A T E"), all normalizing to
// the same "SAMPLECERT" prefix once whitespace is stripped and case is folded — 47 rows total as
// of 2026-08-28, one of them alone accounting for 40 certificates and 17 distinct customers in a
// group_by:"holder" rollup. This surfaced in a real answer on the very first live tool call
// despite being documented as a caveat in the certificates skill — a note telling the calling
// agent to notice and self-censor it isn't reliable enough, so it's filtered out at the query
// level instead, everywhere afw_certholderinfo is read, so it structurally can't be reported as
// if it were a real business relationship.
//
// Checked for false positives before adding this: real company names containing "sample"/"test"/
// "demo"/etc. as substrings do exist in this data (e.g. "Demo Plus Group, Inc.", "Melton
// Structural Testing LLC") — a broad ILIKE '%sample%' filter would have wrongly excluded real
// customers' certificates. The normalized-prefix match only catches the 4 known junk variants.
export function realCertHolderCondition(holderAlias: string): string {
  return `REGEXP_REPLACE(UPPER(${ holderAlias }.name1crth), '\\s+', '', 'g') NOT LIKE 'SAMPLECERT%'`
}
