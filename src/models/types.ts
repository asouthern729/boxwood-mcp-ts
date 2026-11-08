export interface EmployeeInterface {
  empcode: string
  empid: string
  isrep: string
  isprod: string
  istelemarketer: string
  isother: string
  lastname: string
  firstname: string | null
  middlename: string | null
  shortname: string | null
  address1: string | null
  address2: string | null
  city: string | null
  state: string | null
  isforeign: string
  countrycode: string | null
  zip: string | null
  busareacode: string | null
  busphone: string | null
  busext: string | null
  homeareacode: string | null
  homephone: string | null
  homeext: string | null
  faxareacode: string | null
  faxphone: string | null
  faxext: string | null
  dob: Date | null
  // ssn intentionally omitted: the app's `claude` DB role has no SELECT grant on this column
  // (unlike dob, which is granted but always null via ETL exclusion) — selecting it 403s the query.
  fullparttimeind: string | null
  title: string | null
  empsupervisorcode: string | null
  status: string | null
  islicensed: string | null
  mobileareacode: string | null
  mobilephone: string | null
  mobileext: string | null
  pagerareacode: string | null
  pagerphone: string | null
  pagerext: string | null
  ismemocommissions: string | null
  yearemployed: string | null
  emergencycontact: string | null
  contactareacode: string | null
  contactphone: string | null
  contactext: string | null
  imageid: string | null
  imagetype: number | null
  logsuspense: string | null
  email: string | null
  s1099category: number | null
  s1099type: number | null
  tzcode: number
  natlprodcode: string | null
  bjeclosedstatus: string
  islimitcustaccess: string
  doc360hotfolderloc: string | null
  doc360hotspot: string
  employeeid: string | null
  homefullphone: string | null
  busfullphone: string | null
  faxfullphone: string | null
  mobilefullphone: string | null
  pagerfullphone: string | null
  contactfullphone: string | null
  buacsid: string | null
  limitamount: string | null
  changedby: string
  changeddate: Date
  entereddate: Date
  defaultgldivcode: string | null
  defaultglbrnchcode: string | null
  defaultgldeptcode: string | null
  defaultglgrpcode: string | null
  isdefaultbuforcustomer: string | null
  isdefaultbuforpolicy: string | null
}
