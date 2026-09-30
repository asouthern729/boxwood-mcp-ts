// Shared "Last, First" customer name expression (SQL, expects the afw_customer alias `c`) for every
// staff-facing list — the download report and the PL tool pages (Andrew, 2026-09-30: "customers should
// always be listed as last name, first name in the UI. and ordering should use the last name").
//
// "Last, First" for a person (Patrick, 2026-09-29: "Switch to customer last name, First name in first
// column"), otherwise the business name. Keyed on which name fields are filled rather than
// afw_customer.typename, which isn't reliable (~72 typename='I' customers are really LLCs/trusts/
// HOAs with only firmnamecust set). Checked against every customer with a carrier download in the
// prior 90 days (2026-09-30): no business has first+last without a firm name, all 6 individuals with
// a dba are real business DBAs, and joint households keep both names in firstname ("Carney, Addison &
// Grace"). A generational suffix kept in lastname ("Pratt Jr") moves after the first name ("Pratt,
// Paul Jr").
const NAME_SUFFIX_PATTERN = "[ ,]+((?:jr|sr)\\.?|ii|iii|iv)$"
export const CUSTOMER_SORT_NAME_EXPR = `CASE
  WHEN NULLIF(TRIM(c.dba), '') IS NULL AND NULLIF(TRIM(c.firmnamecust), '') IS NULL
    AND NULLIF(TRIM(c.firstname), '') IS NOT NULL AND NULLIF(TRIM(c.lastname), '') IS NOT NULL
  THEN regexp_replace(TRIM(c.lastname), '${ NAME_SUFFIX_PATTERN }', '', 'i') || ', ' || TRIM(c.firstname)
    || COALESCE(' ' || substring(TRIM(c.lastname) FROM '(?i)${ NAME_SUFFIX_PATTERN }'), '')
  ELSE COALESCE(c.dba, NULLIF(TRIM(CONCAT_WS(' ', c.firstname, c.lastname)), ''), c.firmnamecust)
END`
