// afw_employee rows exist for AMS360's own system/integration accounts (DBO, API Services,
// Conversion Service, Administrator, third-party integrations flagged status='S', etc.), so
// a code matching an empcode doesn't by itself mean a human — these known non-human accounts
// have to be excluded explicitly wherever a code is being reported/labeled as a person.
export const SYSTEM_EMPLOYEE_LASTNAMES = ["dbo", "api services", "conversion service", "administrator", "login", "vertafore", "test", "testuser"]

// Raw boolean predicate (not wrapped in EXISTS) against an already-joined afw_employee alias.
export function systemEmployeeCondition(employeeAlias: string): string {
  const lastnameList = SYSTEM_EMPLOYEE_LASTNAMES.map((name) => `'${ name }'`).join(", ")

  return `(${ employeeAlias }.status = 'S' OR lower(${ employeeAlias }.lastname) IN (${ lastnameList }))`
}
