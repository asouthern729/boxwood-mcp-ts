// AMS360 Database Design Guide §4.4.3 per-LOB policy-detail tables (the ~191-table batch built
// 2026-08-29 -- see project memory project_ams360_etl_sync_gaps for the full build history).
// Wired in as policy_query includes, generated 2026-09-01 against the live boxwood_ams360 schema
// (columns, primary keys, claude-role grants) rather than hand-written one at a time, given the
// scale -- reviewed and column-tested against the 4 already-established hand-written includes
// (vehicles/workers_comp/forms/applicant in policyQuery.ts) for pattern consistency.
//
// Naming: include key is the table name with its "afw_" prefix stripped (e.g. afw_126shazard ->
// "126shazard"). Not always a friendly name -- first-pass, table-name-derived; rename on review
// where a clearer name earns its keep. Purpose comments are name-derived guesses except for the
// ~14 top-volume tables with real purpose text from project memory/AMS360 doc.
//
// Dedup: matches the hand-written pattern exactly -- ROW_NUMBER() PARTITION BY (polid[, lobid],
// own PK) ORDER BY effdate DESC, filtered to rn=1 AND status != 'D' when those columns exist. A
// table with no effdate falls back to a plain select (flagged NO DEDUP below) -- confirmed 1:1
// (no Add/Change/Delete history) for several of these via peer review 2026-09-01; verify the rest
// before assuming that holds generally.
//
// Every table below is now fully granted to the claude role (GRANT SELECT run 2026-09-01, closing
// a gap where ~78 of these tables had only sync-metadata columns granted -- see project memory).
// A handful (flagged API-UNAVAILABLE below) will stay empty regardless: the Data Lake API 404s or
// 500s on them for this tenant, confirmed by the ams360-etl peer session 2026-09-01, not a real
// per-tenant LOB-mix gap like the rest of the ~68 currently-empty tables.
//
// 9 tables carry real PII (ssn/dob/license) and are granted on a column-allowlist basis that
// excludes those columns entirely, same convention as afw_applicant/afw_driver etc. -- the
// generated SELECT lists here already respect that, never add the excluded columns back in
// without a matching grant decision.

export const SECTION_443_INCLUDE_OPTIONS = [
  "125natureofbus",
  "125uwsignature",
  "126sclaimsmade",
  "126scontractor",
  "126scoverage",
  "126shazard",
  "126spco",
  "126spcoquestion",
  "127coverage1",
  "127driver",
  "127underwriting",
  "127vehicle",
  "128businessinfo",
  "128covautosymbol",
  "128dealersdamage",
  "128garageoperation",
  "128garkeepers",
  "128storageinfo",
  "130inclexcl",
  "130rating",
  "130submit",
  "131saddexposure",
  "131scoverage",
  "131scus",
  "131sglinfo",
  "131slocation",
  "131spolicy",
  "131sunderlyingpolicy",
  "131svehicle",
  "132authority",
  "132commodities",
  "132coverage",
  "132equipment",
  "132receipts",
  "132regulation",
  "132terminal",
  "132trailerinterchange",
  "140premiseinfo",
  "140subofins",
  "140valuerpt",
  "141classification",
  "141classification2",
  "141control",
  "141depositoryinfo",
  "141employee",
  "141erisainfo",
  "141erisaplan",
  "141generalinfo",
  "141messenger",
  "141messengerprotection",
  "141money",
  "141property",
  "141rating",
  "141safeprotection",
  "141vault",
  "143fobgeninformk",
  "143interesttype",
  "143mtccommodity",
  "143mtclegalliability",
  "143mtcoperation",
  "143mtcstatefiling",
  "143terminal",
  "143transconveyance",
  "143transoperation",
  "144glass",
  "144sign",
  "145account",
  "145bldgconstruction",
  "145location",
  "145papers",
  "145receivables",
  "145recordlocation",
  "145safeprotection",
  "145vault",
  "146equipfloater",
  "146equipsummary",
  "146locations",
  "146schedequip",
  "146storage",
  "146unschedequip",
  "147builderoperation",
  "147jobvalue",
  "147rigtranssecurity",
  "147specificjob",
  "148mediainfo",
  "148schedule",
  "148underwriting",
  "834technologyservices",
  "annualpol",
  "applicantphonemap",
  "attachment",
  "boat",
  "boatengine",
  "boatequipment",
  "boatexperience",
  "boatoperator",
  "boatsummary",
  "boattrailer",
  "building",
  "cbuilding",
  "cform",
  "clocation",
  "cnamedinsured",
  "cnamedinsuredphonemap",
  "coinsured",
  "coinsuredphonemap",
  "commaddotherint",
  "compspecanswer",
  "conviction",
  "coveragehome",
  "covoption",
  "cpremtotal",
  "driveothercar",
  "driver",
  "employer",
  "evidenceofprop",
  "exboatcoverage",
  "factor",
  "farmcategory",
  "farmexclprop",
  "farmgl",
  "farmitem",
  "farmpiuw",
  "farmpremiseinfo",
  "farmpropuw",
  "farmranch",
  "farmsubofins",
  "farmuw",
  "filing",
  "floodlocation",
  "floodrating",
  "floodsectionone",
  "floodsectiontwo",
  "floodtotal",
  "formtype",
  "garage",
  "healthcoverage",
  "healthmember",
  "healthprem",
  "hiredborrowed",
  "homefeature",
  "homerating",
  "homereplacement",
  "horse",
  "horseplanlob",
  "lifebeneficiary",
  "lifecoverage",
  "lifeotherinsurance",
  "lifeowner",
  "location",
  "losshistory",
  "mobilehome",
  "name",
  "nonowned",
  "personalumbrella",
  "persumbrellarating",
  "physician",
  "polcontactphonemap",
  "policyattributehistory",
  "policychklstheader",
  "policypersonnelperiods",
  "policysubcustomer",
  "policytranpremium",
  "polumbrella",
  "pproducer",
  "prevaddr",
  "priorcarrier",
  "queidquestionanswers",
  "ratedate",
  "record",
  "remark",
  "serviceagreement",
  "serviceagreementpolicies",
  "snowmobile",
  "specbuilding",
  "speclocation",
  "specratinganswer",
  "specrisk",
  "specriskanswer",
  "specunderwritinganswer",
  "sppaddinfo",
  "sppitem",
  "sppsummary",
  "submit",
  "umbrellaprem",
  "underwriting",
  "unsupporteddata",
  "usage",
  "watercraft"
] as const

export const SECTION_443_INCLUDE_QUERIES: Record<typeof SECTION_443_INCLUDE_OPTIONS[number], string> = {
  // afw_125natureofbus (atureofbus detail (name-derived, needs review), ~4919 rows)
  "125natureofbus": `
    SELECT t.polid, t.natid, t.effdate, t.status, t.natofbusnat, t.issaved, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.natid, t.effdate, t.status, t.natofbusnat, t.issaved, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.natid ORDER BY t.effdate DESC) AS rn
      FROM afw_125natureofbus t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid
  `,

  // afw_125uwsignature (wsignature detail (name-derived, needs review), ~2178 rows)
  "125uwsignature": `
    SELECT t.polid, t.uwsid, t.effdate, t.status, t.ans1, t.ans1b, t.ans2, t.ans3, t.ans4, t.ans5, t.ans6, t.ans7, t.ans8, t.ans9, t.ans10, t.ans11, t.ans12, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.uwsid, t.effdate, t.status, t.ans1, t.ans1b, t.ans2, t.ans3, t.ans4, t.ans5, t.ans6, t.ans7, t.ans8, t.ans9, t.ans10, t.ans11, t.ans12, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.uwsid ORDER BY t.effdate DESC) AS rn
      FROM afw_125uwsignature t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid
  `,

  // afw_126sclaimsmade (claimsmade detail (name-derived, needs review), ~0 rows) -- API-UNAVAILABLE: Data Lake API 404/500s on this table regardless of tenant (confirmed 2026-09-01), will stay empty regardless of grant status
  "126sclaimsmade": `
    SELECT t.polid, t.lobid, t.scmtid, t.effdate, t.status, t.proprestrodate, t.entrydate, t.answer3, t.answer4, t.remarks, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.scmtid, t.effdate, t.status, t.proprestrodate, t.entrydate, t.answer3, t.answer4, t.remarks, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.scmtid ORDER BY t.effdate DESC) AS rn
      FROM afw_126sclaimsmade t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_126scontractor (contractor detail (name-derived, needs review), ~1262 rows)
  "126scontractor": `
    SELECT t.polid, t.lobid, t.sconid, t.effdate, t.status, t.answer1, t.answer2, t.answer3, t.answer4, t.answer5, t.answer6, t.worksubpct, t.nofulltimestaff, t.noparttimestaff, t.paidsub, t.remarkscon, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.sconid, t.effdate, t.status, t.answer1, t.answer2, t.answer3, t.answer4, t.answer5, t.answer6, t.worksubpct, t.nofulltimestaff, t.noparttimestaff, t.paidsub, t.remarkscon, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.sconid ORDER BY t.effdate DESC) AS rn
      FROM afw_126scontractor t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_126scoverage (coverage detail (name-derived, needs review), ~3450 rows)
  "126scoverage": `
    SELECT t.polid, t.lobid, t.scovid, t.effdate, t.status, t.isclaimsmade, t.liabcovtype, t.othercovscov, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.scovid, t.effdate, t.status, t.isclaimsmade, t.liabcovtype, t.othercovscov, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.scovid ORDER BY t.effdate DESC) AS rn
      FROM afw_126scoverage t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_126shazard (GL schedule of hazards, ~12599 rows)
  "126shazard": `
    SELECT t.polid, t.lobid, t.shazid, t.effdate, t.status, t.clocid, t.classification, t.classcode, t.prembasis, t.exposure, t.territory, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.shazid, t.effdate, t.status, t.clocid, t.classification, t.classcode, t.prembasis, t.exposure, t.territory, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.shazid ORDER BY t.effdate DESC) AS rn
      FROM afw_126shazard t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_126spco (pco detail (name-derived, needs review), ~0 rows)
  "126spco": `
    SELECT t.polid, t.lobid, t.spcoid, t.effdate, t.status, t.products, t.grosssales, t.noofunits, t.timeinmarket, t.expectedlife, t.intendeduse, t.princomponents, t.insertseqno, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.spcoid, t.effdate, t.status, t.products, t.grosssales, t.noofunits, t.timeinmarket, t.expectedlife, t.intendeduse, t.princomponents, t.insertseqno, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.spcoid ORDER BY t.effdate DESC) AS rn
      FROM afw_126spco t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_126spcoquestion (pcoquestion detail (name-derived, needs review), ~1259 rows)
  "126spcoquestion": `
    SELECT t.polid, t.lobid, t.spcoqid, t.effdate, t.status, t.answer1, t.answer2, t.answer3, t.answer4, t.answer5, t.answer6, t.answer7, t.answer8, t.answer9, t.answer10, t.literaturespcoq, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.spcoqid, t.effdate, t.status, t.answer1, t.answer2, t.answer3, t.answer4, t.answer5, t.answer6, t.answer7, t.answer8, t.answer9, t.answer10, t.literaturespcoq, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.spcoqid ORDER BY t.effdate DESC) AS rn
      FROM afw_126spcoquestion t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_127coverage1 (overage1 detail (name-derived, needs review), ~1303 rows)
  "127coverage1": `
    SELECT t.polid, t.lobid, t.casid, t.effdate, t.status, t.isliability1, t.isliability2, t.isliability3, t.isliability4, t.isliability7, t.isliability8, t.isliability9, t.isliabilityother, t.liabilitydesc, t.ispi5, t.ispi7, t.ispip5, t.ispip7, t.ismed2, t.ismed3, t.ismed4, t.ismed7, t.ismed8, t.isum2, t.isum3, t.isum4, t.isum6, t.isum7, t.isum8, t.isum9, t.isuim2, t.isuim3, t.isuim4, t.isuim6, t.isuim7, t.isuim8, t.isuim9, t.propprotsym, t.propprotsym2, t.endorsementscas, t.coverages1, t.coverages2, t.istow3, t.istow7, t.iscomp2, t.iscomp3, t.iscomp4, t.iscomp7, t.iscomp8, t.iscol2, t.iscol3, t.iscol4, t.iscol7, t.iscol8, t.iscollision2, t.iscollision3, t.iscollision4, t.iscollision7, t.iscollision8, t.coverages3, t.cov1sym1, t.cov1sym2, t.cov1sym3, t.cov1sym4, t.cov2sym1, t.cov2sym2, t.cov2sym3, t.cov2sym4, t.cov3sym1, t.cov3sym2, t.cov3sym3, t.cov3sym4, t.ispi2, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.casid, t.effdate, t.status, t.isliability1, t.isliability2, t.isliability3, t.isliability4, t.isliability7, t.isliability8, t.isliability9, t.isliabilityother, t.liabilitydesc, t.ispi5, t.ispi7, t.ispip5, t.ispip7, t.ismed2, t.ismed3, t.ismed4, t.ismed7, t.ismed8, t.isum2, t.isum3, t.isum4, t.isum6, t.isum7, t.isum8, t.isum9, t.isuim2, t.isuim3, t.isuim4, t.isuim6, t.isuim7, t.isuim8, t.isuim9, t.propprotsym, t.propprotsym2, t.endorsementscas, t.coverages1, t.coverages2, t.istow3, t.istow7, t.iscomp2, t.iscomp3, t.iscomp4, t.iscomp7, t.iscomp8, t.iscol2, t.iscol3, t.iscol4, t.iscol7, t.iscol8, t.iscollision2, t.iscollision3, t.iscollision4, t.iscollision7, t.iscollision8, t.coverages3, t.cov1sym1, t.cov1sym2, t.cov1sym3, t.cov1sym4, t.cov2sym1, t.cov2sym2, t.cov2sym3, t.cov2sym4, t.cov3sym1, t.cov3sym2, t.cov3sym3, t.cov3sym4, t.ispi2, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.casid ORDER BY t.effdate DESC) AS rn
      FROM afw_127coverage1 t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_127driver (Commercial-application drivers, ~13646 rows)
  "127driver": `
    SELECT t.polid, t.lobid, t.drivid, t.effdate, t.status, t.driverno, t.name, t.address, t.licenseyear, t.licensestate, t.usevehno, t.usepct, t.city, t.state, t.zip, t.sex, t.datehired, t.commdriversince, t.maritalstatus, t.transormtc, t.excluded, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.drivid, t.effdate, t.status, t.driverno, t.name, t.address, t.licenseyear, t.licensestate, t.usevehno, t.usepct, t.city, t.state, t.zip, t.sex, t.datehired, t.commdriversince, t.maritalstatus, t.transormtc, t.excluded, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.drivid ORDER BY t.effdate DESC) AS rn
      FROM afw_127driver t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_127underwriting (nderwriting detail (name-derived, needs review), ~975 rows)
  "127underwriting": `
    SELECT t.polid, t.lobid, t.bauwid, t.effdate, t.status, t.isanswer1, t.isanswer2, t.isanswer3, t.isanswer4, t.isanswer5, t.isanswer6, t.isanswer7, t.isanswer8, t.isanswer9, t.isanswer10, t.isanswer11, t.isanswer12, t.isanswer13, t.isanswer14, t.isanswer15, t.description1, t.maxdollar, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.bauwid, t.effdate, t.status, t.isanswer1, t.isanswer2, t.isanswer3, t.isanswer4, t.isanswer5, t.isanswer6, t.isanswer7, t.isanswer8, t.isanswer9, t.isanswer10, t.isanswer11, t.isanswer12, t.isanswer13, t.isanswer14, t.isanswer15, t.description1, t.maxdollar, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.bauwid ORDER BY t.effdate DESC) AS rn
      FROM afw_127underwriting t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_127vehicle (Commercial-application vehicles, ~10727 rows)
  "127vehicle": `
    SELECT t.polid, t.lobid, t.vehdid, t.effdate, t.status, t.vehno, t.custvehno, t.vehyear, t.make, t.model, t.bodytype, t.vin, t.symage, t.costnew, t.terr, t.gvwgcw, t.class, t.sic, t.factor, t.seatcp, t.radius, t.farthestterm, t.purchasedate, t.specialuse, t.specialclasscode, t.isfleet, t.primaryratefactpd, t.secondratefact, t.nearzone, t.farzone, t.hp, t.vehusage, t.garid, t.licensestatevehd, t.transormtc, t.newused, t.excludefromautoupdate, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.vehdid, t.effdate, t.status, t.vehno, t.custvehno, t.vehyear, t.make, t.model, t.bodytype, t.vin, t.symage, t.costnew, t.terr, t.gvwgcw, t.class, t.sic, t.factor, t.seatcp, t.radius, t.farthestterm, t.purchasedate, t.specialuse, t.specialclasscode, t.isfleet, t.primaryratefactpd, t.secondratefact, t.nearzone, t.farzone, t.hp, t.vehusage, t.garid, t.licensestatevehd, t.transormtc, t.newused, t.excludefromautoupdate, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.vehdid ORDER BY t.effdate DESC) AS rn
      FROM afw_127vehicle t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_128businessinfo (usinessinfo detail (name-derived, needs review), ~20 rows)
  "128businessinfo": `
    SELECT t.polid, t.lobid, t.gdbiid, t.effdate, t.status, t.isrepshop, t.ismtrldlr, t.issrvstation, t.isctrldlr, t.isstorgar, t.isother, t.otherdesc, t.isfranch, t.carprcnt, t.truckprcnt, t.motorcycleprcnt, t.rvprcnt, t.snowprcnt, t.dlrotherdesc, t.dlrotherprcnt, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.gdbiid, t.effdate, t.status, t.isrepshop, t.ismtrldlr, t.issrvstation, t.isctrldlr, t.isstorgar, t.isother, t.otherdesc, t.isfranch, t.carprcnt, t.truckprcnt, t.motorcycleprcnt, t.rvprcnt, t.snowprcnt, t.dlrotherdesc, t.dlrotherprcnt, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.gdbiid ORDER BY t.effdate DESC) AS rn
      FROM afw_128businessinfo t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_128covautosymbol (ovautosymbol detail (name-derived, needs review), ~14 rows)
  "128covautosymbol": `
    SELECT t.polid, t.lobid, t.gdcasid, t.effdate, t.status, t.isliab21, t.isliab22, t.isliab23, t.isliab24, t.isliab27, t.isliab28, t.isliab29, t.liabedit, t.ispip25, t.ispip27, t.pipdesc, t.isapip25, t.isapip27, t.apipdesc, t.ismed21, t.ismed22, t.ismed23, t.ismed24, t.ismed27, t.ismed28, t.ismed29, t.meddesc, t.isum22, t.isum23, t.isum24, t.isum26, t.isum27, t.isum28, t.isum29, t.umdesc, t.isuim22, t.isuim23, t.isuim24, t.isuim26, t.isuim27, t.isuim28, t.isuim29, t.uimdesc, t.iscomp22, t.iscomp23, t.iscomp24, t.iscomp27, t.iscomp28, t.iscomp31, t.isspec22, t.isspec23, t.isspec24, t.isspec27, t.isspec28, t.isspec31, t.iscoll22, t.iscoll23, t.iscoll24, t.iscoll27, t.iscoll28, t.iscoll31, t.isother22, t.isother23, t.isother24, t.isother27, t.isother28, t.isother31, t.iscomp30, t.iscoll30, t.isspecperil30, t.isother, t.pdothercov, t.gkothercov, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.gdcasid, t.effdate, t.status, t.isliab21, t.isliab22, t.isliab23, t.isliab24, t.isliab27, t.isliab28, t.isliab29, t.liabedit, t.ispip25, t.ispip27, t.pipdesc, t.isapip25, t.isapip27, t.apipdesc, t.ismed21, t.ismed22, t.ismed23, t.ismed24, t.ismed27, t.ismed28, t.ismed29, t.meddesc, t.isum22, t.isum23, t.isum24, t.isum26, t.isum27, t.isum28, t.isum29, t.umdesc, t.isuim22, t.isuim23, t.isuim24, t.isuim26, t.isuim27, t.isuim28, t.isuim29, t.uimdesc, t.iscomp22, t.iscomp23, t.iscomp24, t.iscomp27, t.iscomp28, t.iscomp31, t.isspec22, t.isspec23, t.isspec24, t.isspec27, t.isspec28, t.isspec31, t.iscoll22, t.iscoll23, t.iscoll24, t.iscoll27, t.iscoll28, t.iscoll31, t.isother22, t.isother23, t.isother24, t.isother27, t.isother28, t.isother31, t.iscomp30, t.iscoll30, t.isspecperil30, t.isother, t.pdothercov, t.gkothercov, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.gdcasid ORDER BY t.effdate DESC) AS rn
      FROM afw_128covautosymbol t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_128dealersdamage (ealersdamage detail (name-derived, needs review), ~12 rows)
  "128dealersdamage": `
    SELECT t.polid, t.lobid, t.gdddid, t.effdate, t.status, t.iscompnew, t.iscompused, t.iscompyes1, t.iscompyes2, t.iscompyes3, t.isspnew, t.isspused, t.isspyes1, t.isspyes2, t.isspyes3, t.iscollnew, t.iscollused, t.iscollyes1, t.iscollyes2, t.iscollyes3, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.gdddid, t.effdate, t.status, t.iscompnew, t.iscompused, t.iscompyes1, t.iscompyes2, t.iscompyes3, t.isspnew, t.isspused, t.isspyes1, t.isspyes2, t.isspyes3, t.iscollnew, t.iscollused, t.iscollyes1, t.iscollyes2, t.iscollyes3, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.gdddid ORDER BY t.effdate DESC) AS rn
      FROM afw_128dealersdamage t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_128garageoperation (arageoperation detail (name-derived, needs review), ~17 rows)
  "128garageoperation": `
    SELECT t.polid, t.lobid, t.garid, t.gdgoid, t.effdate, t.status, t.regop, t.regoprate, t.allothers1, t.allothers1rate, t.under25, t.under25rate, t.allothers2, t.allothers2rate, t.nodlrplates, t.norepairplates, t.notranplates, t.nohoists, t.annrem, t.noemp, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.garid, t.gdgoid, t.effdate, t.status, t.regop, t.regoprate, t.allothers1, t.allothers1rate, t.under25, t.under25rate, t.allothers2, t.allothers2rate, t.nodlrplates, t.norepairplates, t.notranplates, t.nohoists, t.annrem, t.noemp, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.gdgoid ORDER BY t.effdate DESC) AS rn
      FROM afw_128garageoperation t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_128garkeepers (arkeepers detail (name-derived, needs review), ~29 rows)
  "128garkeepers": `
    SELECT t.polid, t.lobid, t.garid, t.gdgkid, t.effdate, t.status, t.type, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.garid, t.gdgkid, t.effdate, t.status, t.type, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.gdgkid ORDER BY t.effdate DESC) AS rn
      FROM afw_128garkeepers t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_128storageinfo (torageinfo detail (name-derived, needs review), ~2 rows)
  "128storageinfo": `
    SELECT t.polid, t.lobid, t.garid, t.gdstid, t.effdate, t.status, t.type, t.garriskcd, t.physdamagepercd, t.storagelmt, t.sched, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.garid, t.gdstid, t.effdate, t.status, t.type, t.garriskcd, t.physdamagepercd, t.storagelmt, t.sched, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.gdstid ORDER BY t.effdate DESC) AS rn
      FROM afw_128storageinfo t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_130inclexcl (nclexcl detail (name-derived, needs review), ~670 rows)
  "130inclexcl": `
    SELECT t.polid, t.lobid, t.winxid, t.effdate, t.status, t.name, t.title, t.ownershippct, t.duties, t.incexcl, t.classcode, t.remun, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.winxid, t.effdate, t.status, t.name, t.title, t.ownershippct, t.duties, t.incexcl, t.classcode, t.remun, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.winxid ORDER BY t.effdate DESC) AS rn
      FROM afw_130inclexcl t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_130rating (ating detail (name-derived, needs review), ~8138 rows)
  "130rating": `
    SELECT t.polid, t.lobid, t.wratid, t.effdate, t.status, t.attachid, t.attachtype, t.ratingstate, t.clocid, t.ratingclasscode, t.categories, t.noofemp, t.noofemppart, t.noofempfull, t.ratingbasis, t.vestannremun, t.iestannremun, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.wratid, t.effdate, t.status, t.attachid, t.attachtype, t.ratingstate, t.clocid, t.ratingclasscode, t.categories, t.noofemp, t.noofemppart, t.noofempfull, t.ratingbasis, t.vestannremun, t.iestannremun, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.wratid ORDER BY t.effdate DESC) AS rn
      FROM afw_130rating t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_130submit (ubmit detail (name-derived, needs review), ~812 rows)
  "130submit": `
    SELECT t.polid, t.lobid, t.wsubid, t.effdate, t.status, t.isclaimsmade, t.liabtype, t.addlcovendwsub, t.subpctwsub, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.wsubid, t.effdate, t.status, t.isclaimsmade, t.liabtype, t.addlcovendwsub, t.subpctwsub, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.wsubid ORDER BY t.effdate DESC) AS rn
      FROM afw_130submit t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_131saddexposure (addexposure detail (name-derived, needs review), ~844 rows)
  "131saddexposure": `
    SELECT t.polid, t.lobid, t.uaxid, t.effdate, t.status, t.mediaused, t.annualcost, t.advliaquest2, t.advliaquest3, t.aircraftquest4, t.autoliaquest5, t.autoliaquest6, t.autoliaquest7, t.autoliaquest8, t.autoliaquest9, t.conliaquest10, t.conliaquest11, t.conliaquest12, t.conliaquest13, t.conliaquest14, t.empliaquest15, t.jonesact, t.fela, t.stopgap, t.empliaother1, t.empliaother2, t.incmalpquest17, t.incmalpquest18, t.noofdoctors, t.noofnurses, t.noofbeds, t.epano, t.polliaquest20, t.glstandardiso, t.glsudden, t.glpollution, t.seppollution, t.prodliaquest22, t.prodliaquest23, t.prodliaquest24, t.prodliaquest25, t.grosssales1yr, t.grosssales2yr, t.grosssales3yr, t.prodliaquest27, t.waterliaquest28, t.isboatowned, t.boatlength, t.boathorsepower, t.boatdescription, t.apartnoofstories, t.apartnoofunits, t.apartnoofpools, t.apartnoofdivbrds, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.uaxid, t.effdate, t.status, t.mediaused, t.annualcost, t.advliaquest2, t.advliaquest3, t.aircraftquest4, t.autoliaquest5, t.autoliaquest6, t.autoliaquest7, t.autoliaquest8, t.autoliaquest9, t.conliaquest10, t.conliaquest11, t.conliaquest12, t.conliaquest13, t.conliaquest14, t.empliaquest15, t.jonesact, t.fela, t.stopgap, t.empliaother1, t.empliaother2, t.incmalpquest17, t.incmalpquest18, t.noofdoctors, t.noofnurses, t.noofbeds, t.epano, t.polliaquest20, t.glstandardiso, t.glsudden, t.glpollution, t.seppollution, t.prodliaquest22, t.prodliaquest23, t.prodliaquest24, t.prodliaquest25, t.grosssales1yr, t.grosssales2yr, t.grosssales3yr, t.prodliaquest27, t.waterliaquest28, t.isboatowned, t.boatlength, t.boathorsepower, t.boatdescription, t.apartnoofstories, t.apartnoofunits, t.apartnoofpools, t.apartnoofdivbrds, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.uaxid ORDER BY t.effdate DESC) AS rn
      FROM afw_131saddexposure t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_131scoverage (coverage detail (name-derived, needs review), ~650 rows)
  "131scoverage": `
    SELECT t.polid, t.lobid, t.ucovid, t.effdate, t.status, t.isanyauto, t.isclaimsmade, t.isaircraftcov, t.isaircraftexp, t.isairpasscov, t.isairpassexp, t.isaddlintcov, t.isaddlintexp, t.isccccov, t.iscccexp, t.isempcov, t.isempexp, t.isforeigncov, t.isforeignexp, t.isgaragecov, t.isgarageexp, t.ismedicalcov, t.ismedicalexp, t.isliquorcov, t.isliquorexp, t.ispollutioncov, t.ispollutionexp, t.isprofcov, t.isprofexp, t.isvendorcov, t.isvendorexp, t.iswatercraftcov, t.iswatercraftexp, t.other1, t.isother1cov, t.isother1exp, t.other2, t.isother2cov, t.isother2exp, t.other3, t.isother3cov, t.isother3exp, t.other4, t.isother4cov, t.isother4exp, t.covinfoucov, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.ucovid, t.effdate, t.status, t.isanyauto, t.isclaimsmade, t.isaircraftcov, t.isaircraftexp, t.isairpasscov, t.isairpassexp, t.isaddlintcov, t.isaddlintexp, t.isccccov, t.iscccexp, t.isempcov, t.isempexp, t.isforeigncov, t.isforeignexp, t.isgaragecov, t.isgarageexp, t.ismedicalcov, t.ismedicalexp, t.isliquorcov, t.isliquorexp, t.ispollutioncov, t.ispollutionexp, t.isprofcov, t.isprofexp, t.isvendorcov, t.isvendorexp, t.iswatercraftcov, t.iswatercraftexp, t.other1, t.isother1cov, t.isother1exp, t.other2, t.isother2cov, t.isother2exp, t.other3, t.isother3cov, t.isother3exp, t.other4, t.isother4cov, t.isother4exp, t.covinfoucov, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.ucovid ORDER BY t.effdate DESC) AS rn
      FROM afw_131scoverage t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_131scus (cus detail (name-derived, needs review), ~3 rows)
  "131scus": `
    SELECT t.polid, t.lobid, t.ucusid, t.effdate, t.status, t.ucuslocno, t.realprop, t.personalprop, t.propvalue, t.a, t.b, t.c, t.d, t.sqft, t.occdescr, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.ucusid, t.effdate, t.status, t.ucuslocno, t.realprop, t.personalprop, t.propvalue, t.a, t.b, t.c, t.d, t.sqft, t.occdescr, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.ucusid ORDER BY t.effdate DESC) AS rn
      FROM afw_131scus t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_131sglinfo (glinfo detail (name-derived, needs review), ~1026 rows)
  "131sglinfo": `
    SELECT t.polid, t.lobid, t.uglid, t.effdate, t.status, t.ans1, t.ans2, t.isans3, t.ans4, t.ans5, t.isans6, t.ans6effdate, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.uglid, t.effdate, t.status, t.ans1, t.ans2, t.isans3, t.ans4, t.ans5, t.isans6, t.ans6effdate, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.uglid ORDER BY t.effdate DESC) AS rn
      FROM afw_131sglinfo t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_131slocation (location detail (name-derived, needs review), ~4767 rows)
  "131slocation": `
    SELECT t.polid, t.lobid, t.ulocid, t.effdate, t.status, t.ulocno, t.name, t.addr1, t.addr2, t.city, t.state, t.zip, t.annualpayroll, t.annualgrosssale, t.foreigngrosssale, t.noofemp, t.clocid, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.ulocid, t.effdate, t.status, t.ulocno, t.name, t.addr1, t.addr2, t.city, t.state, t.zip, t.annualpayroll, t.annualgrosssale, t.foreigngrosssale, t.noofemp, t.clocid, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.ulocid ORDER BY t.effdate DESC) AS rn
      FROM afw_131slocation t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_131spolicy (policy detail (name-derived, needs review), ~0 rows) -- API-UNAVAILABLE: Data Lake API 404/500s on this table regardless of tenant (confirmed 2026-09-01), will stay empty regardless of grant status
  "131spolicy": `
    SELECT t.polid, t.lobid, t.upolid, t.effdate, t.status, t.isumbrella, t.proprtrodate, t.expirpolno, t.curretrodate, t.isdollaryes, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.upolid, t.effdate, t.status, t.isumbrella, t.proprtrodate, t.expirpolno, t.curretrodate, t.isdollaryes, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.upolid ORDER BY t.effdate DESC) AS rn
      FROM afw_131spolicy t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_131sunderlyingpolicy (underlyingpolicy detail (name-derived, needs review), ~3614 rows)
  "131sunderlyingpolicy": `
    SELECT t.polid, t.lobid, t.undpid, t.effdate, t.status, t.liabpoltype, t.isclaimsmade, t.othertype, t.polno, t.carrier, t.poleffdate, t.polexpdate, t.vlimit1, t.ilimit1, t.vlimit2, t.ilimit2, t.vlimit3, t.ilimit3, t.vlimit4, t.ilimit4, t.vlimit5, t.ilimit5, t.vlimit6, t.ilimit6, t.prem1, t.prem2, t.prem3, t.ratingmod1, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.undpid, t.effdate, t.status, t.liabpoltype, t.isclaimsmade, t.othertype, t.polno, t.carrier, t.poleffdate, t.polexpdate, t.vlimit1, t.ilimit1, t.vlimit2, t.ilimit2, t.vlimit3, t.ilimit3, t.vlimit4, t.ilimit4, t.vlimit5, t.ilimit5, t.vlimit6, t.ilimit6, t.prem1, t.prem2, t.prem3, t.ratingmod1, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.undpid ORDER BY t.effdate DESC) AS rn
      FROM afw_131sunderlyingpolicy t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_131svehicle (vehicle detail (name-derived, needs review), ~293 rows)
  "131svehicle": `
    SELECT t.polid, t.lobid, t.uvehid, t.effdate, t.status, t.vehicletype, t.noowned, t.nononowned, t.noleased, t.propertyhauled, t.miles0to50, t.miles50to200, t.milesover200, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.uvehid, t.effdate, t.status, t.vehicletype, t.noowned, t.nononowned, t.noleased, t.propertyhauled, t.miles0to50, t.miles50to200, t.milesover200, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.uvehid ORDER BY t.effdate DESC) AS rn
      FROM afw_131svehicle t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_132authority (uthority detail (name-derived, needs review), ~0 rows)
  "132authority": `
    SELECT t.polid, t.lobid, t.trregid, t.trautid, t.effdate, t.status, t.state, t.liabintraexempt, t.cargointraexempt, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.trregid, t.trautid, t.effdate, t.status, t.state, t.liabintraexempt, t.cargointraexempt, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.trregid, t.trautid ORDER BY t.effdate DESC) AS rn
      FROM afw_132authority t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_132commodities (ommodities detail (name-derived, needs review), ~0 rows)
  "132commodities": `
    SELECT t.polid, t.lobid, t.trcomid, t.effdate, t.status, t.commtransported, t.totalrevenuepct, t.valuepertruckload, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.trcomid, t.effdate, t.status, t.commtransported, t.totalrevenuepct, t.valuepertruckload, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.trcomid ORDER BY t.effdate DESC) AS rn
      FROM afw_132commodities t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_132coverage (overage detail (name-derived, needs review), ~0 rows)
  "132coverage": `
    SELECT t.polid, t.lobid, t.trcovid, t.effdate, t.status, t.isliab41, t.isliab42, t.isliab43, t.isliab46, t.isliab47, t.isliab50, t.ispip44, t.ispip46, t.isapip44, t.isapip46, t.ismedpay42, t.ismedpay43, t.ismedpay46, t.isum42, t.isum43, t.isum45, t.isum46, t.isum47, t.isum50, t.isum68, t.isum71, t.isuim42, t.isuim43, t.isuim45, t.isuim46, t.isuim47, t.isuim50, t.isuim68, t.isuim71, t.iscomp42, t.iscomp43, t.iscomp46, t.iscomp47, t.iscomp48, t.iscomp49, t.issp42, t.issp43, t.issp46, t.issp47, t.issp48, t.issp49, t.iscoll42, t.iscoll43, t.iscoll46, t.iscoll47, t.iscoll48, t.iscoll49, t.istl46, t.apipdesc, t.pipdesc, t.medpaydesc, t.umdesc, t.uimdesc, t.coverage1, t.coverage2, t.cov1sym1, t.cov1sym2, t.cov1sym3, t.cov1sym4, t.cov2sym1, t.cov2sym2, t.cov2sym3, t.cov2sym4, t.iscomp62, t.iscomp63, t.iscomp64, t.iscomp67, t.iscomp68, t.iscomp69, t.iscomp70, t.issp62, t.issp63, t.issp64, t.issp67, t.issp68, t.issp69, t.issp70, t.iscoll62, t.iscoll63, t.iscoll64, t.iscoll67, t.iscoll68, t.iscoll69, t.iscoll70, t.isliab61, t.isliab62, t.isliab63, t.isliab64, t.isliab67, t.isliab68, t.isliab71, t.ismedpay62, t.ismedpay63, t.ismedpay64, t.ismedpay67, t.ispip65, t.ispip67, t.isapip65, t.isapip67, t.isum62, t.isum63, t.isum64, t.isum66, t.isum67, t.isuim62, t.isuim63, t.isuim64, t.isuim66, t.isuim67, t.istl63, t.istl67, t.motpipdesc, t.motapipdesc, t.motmeddesc, t.motuimdesc, t.motumdesc, t.coverage3, t.coverage4, t.cov3sym1, t.cov3sym2, t.cov3sym3, t.cov3sym4, t.cov4sym1, t.cov4sym2, t.cov4sym3, t.cov4sym4, t.endorsement, t.propprotsym, t.propprotsym2, t.motpropprotsym, t.motpropprotsym2, t.mcendorsement, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.trcovid, t.effdate, t.status, t.isliab41, t.isliab42, t.isliab43, t.isliab46, t.isliab47, t.isliab50, t.ispip44, t.ispip46, t.isapip44, t.isapip46, t.ismedpay42, t.ismedpay43, t.ismedpay46, t.isum42, t.isum43, t.isum45, t.isum46, t.isum47, t.isum50, t.isum68, t.isum71, t.isuim42, t.isuim43, t.isuim45, t.isuim46, t.isuim47, t.isuim50, t.isuim68, t.isuim71, t.iscomp42, t.iscomp43, t.iscomp46, t.iscomp47, t.iscomp48, t.iscomp49, t.issp42, t.issp43, t.issp46, t.issp47, t.issp48, t.issp49, t.iscoll42, t.iscoll43, t.iscoll46, t.iscoll47, t.iscoll48, t.iscoll49, t.istl46, t.apipdesc, t.pipdesc, t.medpaydesc, t.umdesc, t.uimdesc, t.coverage1, t.coverage2, t.cov1sym1, t.cov1sym2, t.cov1sym3, t.cov1sym4, t.cov2sym1, t.cov2sym2, t.cov2sym3, t.cov2sym4, t.iscomp62, t.iscomp63, t.iscomp64, t.iscomp67, t.iscomp68, t.iscomp69, t.iscomp70, t.issp62, t.issp63, t.issp64, t.issp67, t.issp68, t.issp69, t.issp70, t.iscoll62, t.iscoll63, t.iscoll64, t.iscoll67, t.iscoll68, t.iscoll69, t.iscoll70, t.isliab61, t.isliab62, t.isliab63, t.isliab64, t.isliab67, t.isliab68, t.isliab71, t.ismedpay62, t.ismedpay63, t.ismedpay64, t.ismedpay67, t.ispip65, t.ispip67, t.isapip65, t.isapip67, t.isum62, t.isum63, t.isum64, t.isum66, t.isum67, t.isuim62, t.isuim63, t.isuim64, t.isuim66, t.isuim67, t.istl63, t.istl67, t.motpipdesc, t.motapipdesc, t.motmeddesc, t.motuimdesc, t.motumdesc, t.coverage3, t.coverage4, t.cov3sym1, t.cov3sym2, t.cov3sym3, t.cov3sym4, t.cov4sym1, t.cov4sym2, t.cov4sym3, t.cov4sym4, t.endorsement, t.propprotsym, t.propprotsym2, t.motpropprotsym, t.motpropprotsym2, t.mcendorsement, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.trcovid ORDER BY t.effdate DESC) AS rn
      FROM afw_132coverage t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_132equipment (quipment detail (name-derived, needs review), ~0 rows)
  "132equipment": `
    SELECT t.polid, t.lobid, t.treqpid, t.effdate, t.status, t.vehtype, t.compowned, t.nonowned, t.longtermlease, t.triplease, t.local, t.intermediate, t.longdistance, t.territory, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.treqpid, t.effdate, t.status, t.vehtype, t.compowned, t.nonowned, t.longtermlease, t.triplease, t.local, t.intermediate, t.longdistance, t.territory, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.treqpid ORDER BY t.effdate DESC) AS rn
      FROM afw_132equipment t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_132receipts (eceipts detail (name-derived, needs review), ~0 rows)
  "132receipts": `
    SELECT t.polid, t.lobid, t.trrecid, t.effdate, t.status, t.state, t.iswcind, t.grsreceiptscurrentyr, t.grsreceiptsnextyr, t.grsreceiptslastyr, t.grsreceiptsyrbeforelast, t.totalmileagecurrentyr, t.totalmileagenextyr, t.totalmileagelastyr, t.totalmileageyrbeforelast, t.powerunitscurrentyr, t.powerunitsnextyr, t.powerunitslastyr, t.powerunitsyrbeforelast, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.trrecid, t.effdate, t.status, t.state, t.iswcind, t.grsreceiptscurrentyr, t.grsreceiptsnextyr, t.grsreceiptslastyr, t.grsreceiptsyrbeforelast, t.totalmileagecurrentyr, t.totalmileagenextyr, t.totalmileagelastyr, t.totalmileageyrbeforelast, t.powerunitscurrentyr, t.powerunitsnextyr, t.powerunitslastyr, t.powerunitsyrbeforelast, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.trrecid ORDER BY t.effdate DESC) AS rn
      FROM afw_132receipts t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_132regulation (egulation detail (name-derived, needs review), ~0 rows)
  "132regulation": `
    SELECT t.polid, t.lobid, t.trregid, t.effdate, t.status, t.shippers, t.iscomcar, t.iscontcar, t.isprivcar, t.isdotrating, t.dotratingdesc, t.isdocket1, t.docket1desc, t.isiccfiling, t.iccfilingdesc, t.filingname, t.liapolno, t.carpolno, t.iliablimit, t.vliablimit, t.icarlimit, t.vcarlimit, t.liabeffdate, t.careffdate, t.liabmccode, t.carmccode, t.basestate, t.explaindesc, t.canprovinces, t.overcert, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.trregid, t.effdate, t.status, t.shippers, t.iscomcar, t.iscontcar, t.isprivcar, t.isdotrating, t.dotratingdesc, t.isdocket1, t.docket1desc, t.isiccfiling, t.iccfilingdesc, t.filingname, t.liapolno, t.carpolno, t.iliablimit, t.vliablimit, t.icarlimit, t.vcarlimit, t.liabeffdate, t.careffdate, t.liabmccode, t.carmccode, t.basestate, t.explaindesc, t.canprovinces, t.overcert, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.trregid ORDER BY t.effdate DESC) AS rn
      FROM afw_132regulation t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_132terminal (erminal detail (name-derived, needs review), ~0 rows)
  "132terminal": `
    SELECT t.polid, t.lobid, t.trtrmid, t.effdate, t.status, t.termlocno, t.vehno, t.distgar, t.clocid, t.zoneno, t.name, t.addr1, t.addr2, t.city, t.county, t.state, t.zip, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.trtrmid, t.effdate, t.status, t.termlocno, t.vehno, t.distgar, t.clocid, t.zoneno, t.name, t.addr1, t.addr2, t.city, t.county, t.state, t.zip, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.trtrmid ORDER BY t.effdate DESC) AS rn
      FROM afw_132terminal t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_132trailerinterchange (railerinterchange detail (name-derived, needs review), ~0 rows)
  "132trailerinterchange": `
    SELECT t.polid, t.lobid, t.trtiid, t.effdate, t.status, t.state, t.numbertrl, t.numberdays, t.radius, t.radiuscode, t.fterminalzone, t.applies, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.trtiid, t.effdate, t.status, t.state, t.numbertrl, t.numberdays, t.radius, t.radiuscode, t.fterminalzone, t.applies, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.trtiid ORDER BY t.effdate DESC) AS rn
      FROM afw_132trailerinterchange t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_140premiseinfo (Crime/commercial premises info, ~11616 rows)
  "140premiseinfo": `
    SELECT t.polid, t.lobid, t.piid, t.effdate, t.status, t.clocid, t.cbldgid, t.description, t.othercoverages, t.consttype, t.firedist, t.protclass, t.noofstories, t.noofbase, t.yearblt, t.totalarea, t.wiring, t.wiringyr, t.roofing, t.roofingyr, t.plumbing, t.plumbingyr, t.heating, t.heatingyr, t.otherupdate, t.otherupdateyr, t.otheroccup, t.rightexpdist, t.leftexpdist, t.rearexpdist, t.burgalarmtype, t.certno, t.expdate, t.extent, t.grade, t.burgalarminstall, t.noofguards, t.burgotherde, t.fireprot, t.firealarmman, t.taxcode, t.typeofbus, t.rooftype, t.windclass, t.bldgcodegrade, t.mfgarea, t.mercarea, t.rightdist, t.leftdist, t.reardist, t.hydrantdist, t.firestatdist, t.firecodeno, t.firealarmtype, t.issprinklered, t.sprinkpct, t.isboilerprem, t.isinselsewhere, t.alarmcontact, t.totalvalues, t.totalamount, t.frontexpdist, t.frontdist, t.totalitems, t.imlocid, t.opensides, t.otherupdateyear, t.changedby, t.changeddate, t.entereddate, t.fungusexclusion, t.fungusexclusionformused, t.fungusexclusionformdate, t.fungusexclusionformowner
    FROM (
      SELECT t.polid, t.lobid, t.piid, t.effdate, t.status, t.clocid, t.cbldgid, t.description, t.othercoverages, t.consttype, t.firedist, t.protclass, t.noofstories, t.noofbase, t.yearblt, t.totalarea, t.wiring, t.wiringyr, t.roofing, t.roofingyr, t.plumbing, t.plumbingyr, t.heating, t.heatingyr, t.otherupdate, t.otherupdateyr, t.otheroccup, t.rightexpdist, t.leftexpdist, t.rearexpdist, t.burgalarmtype, t.certno, t.expdate, t.extent, t.grade, t.burgalarminstall, t.noofguards, t.burgotherde, t.fireprot, t.firealarmman, t.taxcode, t.typeofbus, t.rooftype, t.windclass, t.bldgcodegrade, t.mfgarea, t.mercarea, t.rightdist, t.leftdist, t.reardist, t.hydrantdist, t.firestatdist, t.firecodeno, t.firealarmtype, t.issprinklered, t.sprinkpct, t.isboilerprem, t.isinselsewhere, t.alarmcontact, t.totalvalues, t.totalamount, t.frontexpdist, t.frontdist, t.totalitems, t.imlocid, t.opensides, t.otherupdateyear, t.changedby, t.changeddate, t.entereddate, t.fungusexclusion, t.fungusexclusionformused, t.fungusexclusionformdate, t.fungusexclusionformowner,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.piid ORDER BY t.effdate DESC) AS rn
      FROM afw_140premiseinfo t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_140subofins (ubofins detail (name-derived, needs review), ~0 rows) -- API-UNAVAILABLE: Data Lake API 404/500s on this table regardless of tenant (confirmed 2026-09-01), will stay empty regardless of grant status
  "140subofins": `
    SELECT t.polid, t.lobid, t.soiid, t.effdate, t.status, t.piid, t.subofins, t.isubamt, t.vsubamt, t.valuation, t.ratingtype, t.isotelno, t.cspcode, t.perrestday, t.insertseqno, t.isinclude139, t.isinclude159, t."100percentval", t.changedby, t.changeddate, t.entereddate, t.blanketnumber, t.blankettype
    FROM (
      SELECT t.polid, t.lobid, t.soiid, t.effdate, t.status, t.piid, t.subofins, t.isubamt, t.vsubamt, t.valuation, t.ratingtype, t.isotelno, t.cspcode, t.perrestday, t.insertseqno, t.isinclude139, t.isinclude159, t."100percentval", t.changedby, t.changeddate, t.entereddate, t.blanketnumber, t.blankettype,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.soiid ORDER BY t.effdate DESC) AS rn
      FROM afw_140subofins t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_140valuerpt (aluerpt detail (name-derived, needs review), ~39 rows)
  "140valuerpt": `
    SELECT t.polid, t.lobid, t.vaid, t.effdate, t.status, t.subofins, t.premises, t.declaredloc, t.acquiredloc, t.premiseslimit, t.aggregate, t.premno, t.bldgno, t.piid, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.vaid, t.effdate, t.status, t.subofins, t.premises, t.declaredloc, t.acquiredloc, t.premiseslimit, t.aggregate, t.premno, t.bldgno, t.piid, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.vaid ORDER BY t.effdate DESC) AS rn
      FROM afw_140valuerpt t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141classification (lassification detail (name-derived, needs review), ~0 rows)
  "141classification": `
    SELECT t.polid, t.lobid, t.crclid, t.effdate, t.status, t.jobtitle, t.noofemp, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.crclid, t.effdate, t.status, t.jobtitle, t.noofemp, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.crclid ORDER BY t.effdate DESC) AS rn
      FROM afw_141classification t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141classification2 (lassification2 detail (name-derived, needs review), ~0 rows)
  "141classification2": `
    SELECT t.polid, t.lobid, t.crcl2id, t.effdate, t.status, t.noofofficer, t.totalotheremp, t.noofretailloc, t.noofotherloc, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.crcl2id, t.effdate, t.status, t.noofofficer, t.totalotheremp, t.noofretailloc, t.noofotherloc, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.crcl2id ORDER BY t.effdate DESC) AS rn
      FROM afw_141classification2 t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141control (ontrol detail (name-derived, needs review), ~0 rows)
  "141control": `
    SELECT t.polid, t.lobid, t.crconid, t.effdate, t.status, t.auditby, t.auditotherdesc, t.auditfrequency, t.freqotherdesc, t.isinventoryincl, t.rptrenderto, t.rptotherdesc, t.isnotauthorized, t.iscntsigreq, t.whosigns, t.isjointcontrol, t.isvacationreq, t.saaauditfrequency, t.auditname, t.addr1, t.addr2, t.city, t.state, t.zip, t.isalllocs, t.isstandard, t.isauditrptrender, t.cashaccauditdate, t.invenauditdate, t.isanydiscrep, t.isinternalaudit, t.isinternauditrender, t.isintnotauthorized, t.isintctsigreq, t.isintjointcontrol, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.crconid, t.effdate, t.status, t.auditby, t.auditotherdesc, t.auditfrequency, t.freqotherdesc, t.isinventoryincl, t.rptrenderto, t.rptotherdesc, t.isnotauthorized, t.iscntsigreq, t.whosigns, t.isjointcontrol, t.isvacationreq, t.saaauditfrequency, t.auditname, t.addr1, t.addr2, t.city, t.state, t.zip, t.isalllocs, t.isstandard, t.isauditrptrender, t.cashaccauditdate, t.invenauditdate, t.isanydiscrep, t.isinternalaudit, t.isinternauditrender, t.isintnotauthorized, t.isintctsigreq, t.isintjointcontrol, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.crconid ORDER BY t.effdate DESC) AS rn
      FROM afw_141control t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141depositoryinfo (epositoryinfo detail (name-derived, needs review), ~0 rows)
  "141depositoryinfo": `
    SELECT t.polid, t.lobid, t.cpremid, t.crdepid, t.effdate, t.status, t.type, t.custodianno, t.namecrdep, t.addr1, t.addr2, t.city, t.state, t.zip, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.cpremid, t.crdepid, t.effdate, t.status, t.type, t.custodianno, t.namecrdep, t.addr1, t.addr2, t.city, t.state, t.zip, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.cpremid, t.crdepid ORDER BY t.effdate DESC) AS rn
      FROM afw_141depositoryinfo t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141employee (mployee detail (name-derived, needs review), ~0 rows)
  "141employee": `
    SELECT t.polid, t.lobid, t.crempid, t.effdate, t.status, t.clocid, t.empname, t.title, t.ilimit, t.vlimit, t.deduct, t.dedtype, t.premium, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.crempid, t.effdate, t.status, t.clocid, t.empname, t.title, t.ilimit, t.vlimit, t.deduct, t.dedtype, t.premium, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.crempid ORDER BY t.effdate DESC) AS rn
      FROM afw_141employee t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141erisainfo (risainfo detail (name-derived, needs review), ~0 rows) -- API-UNAVAILABLE: Data Lake API 404/500s on this table regardless of tenant (confirmed 2026-09-01), will stay empty regardless of grant status
  "141erisainfo": `
    SELECT t.polid, t.lobid, t.crinfid, t.effdate, t.status, t.islicsecurities, t.noofrustees, t.noofparticipants, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.crinfid, t.effdate, t.status, t.islicsecurities, t.noofrustees, t.noofparticipants, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.crinfid ORDER BY t.effdate DESC) AS rn
      FROM afw_141erisainfo t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141erisaplan (risaplan detail (name-derived, needs review), ~10 rows)
  "141erisaplan": `
    SELECT t.polid, t.lobid, t.crplnid, t.effdate, t.status, t.planname, t.addr1, t.addr2, t.city, t.state, t.zip, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.crplnid, t.effdate, t.status, t.planname, t.addr1, t.addr2, t.city, t.state, t.zip, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.crplnid ORDER BY t.effdate DESC) AS rn
      FROM afw_141erisaplan t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141generalinfo (eneralinfo detail (name-derived, needs review), ~4 rows)
  "141generalinfo": `
    SELECT t.polid, t.lobid, t.piid, t.crgenid, t.effdate, t.status, t.bushoursstart, t.bushoursclose, t.avgnoemponduty, t.checkstampeddeposit, t.depositfreq, t.nightdeposit, t.anngrosssales, t.otherinfo, t.doubledoorlock, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.piid, t.crgenid, t.effdate, t.status, t.bushoursstart, t.bushoursclose, t.avgnoemponduty, t.checkstampeddeposit, t.depositfreq, t.nightdeposit, t.anngrosssales, t.otherinfo, t.doubledoorlock, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.piid, t.crgenid ORDER BY t.effdate DESC) AS rn
      FROM afw_141generalinfo t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141messenger (essenger detail (name-derived, needs review), ~0 rows)
  "141messenger": `
    SELECT t.polid, t.lobid, t.crmesid, t.effdate, t.status, t.clocid, t.noofmessenger, t.noofarmoredvehs, t.iinsidelimit, t.vinsidelimit, t.ioutsidelimit, t.voutsidelimit, t.deduct, t.dedtype, t.premium, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.crmesid, t.effdate, t.status, t.clocid, t.noofmessenger, t.noofarmoredvehs, t.iinsidelimit, t.vinsidelimit, t.ioutsidelimit, t.voutsidelimit, t.deduct, t.dedtype, t.premium, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.crmesid ORDER BY t.effdate DESC) AS rn
      FROM afw_141messenger t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141messengerprotection (essengerprotection detail (name-derived, needs review), ~0 rows)
  "141messengerprotection": `
    SELECT t.polid, t.lobid, t.piid, t.crmproid, t.effdate, t.status, t.messenger, t.noofguards, t.isprivconveyance, t.issafetysatchel, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.piid, t.crmproid, t.effdate, t.status, t.messenger, t.noofguards, t.isprivconveyance, t.issafetysatchel, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.piid, t.crmproid ORDER BY t.effdate DESC) AS rn
      FROM afw_141messengerprotection t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141money (oney detail (name-derived, needs review), ~0 rows)
  "141money": `
    SELECT t.polid, t.lobid, t.piid, t.crmonid, t.effdate, t.status, t.type, t.moneycrmon, t.security, t.checkcrmon, t.payroll, t.overnight, t.securityinbank, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.piid, t.crmonid, t.effdate, t.status, t.type, t.moneycrmon, t.security, t.checkcrmon, t.payroll, t.overnight, t.securityinbank, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.piid, t.crmonid ORDER BY t.effdate DESC) AS rn
      FROM afw_141money t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141property (roperty detail (name-derived, needs review), ~0 rows)
  "141property": `
    SELECT t.polid, t.lobid, t.piid, t.crpropid, t.effdate, t.status, t.propdesc, t.propmaxvalue, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.piid, t.crpropid, t.effdate, t.status, t.propdesc, t.propmaxvalue, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.piid, t.crpropid ORDER BY t.effdate DESC) AS rn
      FROM afw_141property t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141rating (ating detail (name-derived, needs review), ~147 rows)
  "141rating": `
    SELECT t.polid, t.lobid, t.piid, t.crratid, t.effdate, t.status, t.plancode, t.crimeclasscode, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.piid, t.crratid, t.effdate, t.status, t.plancode, t.crimeclasscode, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.piid, t.crratid ORDER BY t.effdate DESC) AS rn
      FROM afw_141rating t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141safeprotection (afeprotection detail (name-derived, needs review), ~0 rows)
  "141safeprotection": `
    SELECT t.polid, t.lobid, t.piid, t.crsafid, t.effdate, t.status, t.alarmtype, t.alarmdesc, t.grade, t.extentofprotection, t.alarminstallby, t.noofguards, t.noofwatch, t.watchpersons, t.certno, t.certexpdate, t.accessopenprotect, t.otherprotect, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.piid, t.crsafid, t.effdate, t.status, t.alarmtype, t.alarmdesc, t.grade, t.extentofprotection, t.alarminstallby, t.noofguards, t.noofwatch, t.watchpersons, t.certno, t.certexpdate, t.accessopenprotect, t.otherprotect, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.piid, t.crsafid ORDER BY t.effdate DESC) AS rn
      FROM afw_141safeprotection t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_141vault (ault detail (name-derived, needs review), ~0 rows)
  "141vault": `
    SELECT t.polid, t.lobid, t.piid, t.crvauid, t.effdate, t.status, t.manufacturer, t.label, t.class, t.door, t.outerlock, t.innerlock, t.chestlock, t.doorthickness, t.wallthickness, t.construction, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.piid, t.crvauid, t.effdate, t.status, t.manufacturer, t.label, t.class, t.door, t.outerlock, t.innerlock, t.chestlock, t.doorthickness, t.wallthickness, t.construction, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.piid, t.crvauid ORDER BY t.effdate DESC) AS rn
      FROM afw_141vault t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_143fobgeninformk (obgeninformk detail (name-derived, needs review), ~0 rows)
  "143fobgeninformk": `
    SELECT t.polid, t.lobid, t.tintid, t.tfobid, t.effdate, t.status, t.iscontingent, t.fobpct, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.tintid, t.tfobid, t.effdate, t.status, t.iscontingent, t.fobpct, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.tintid, t.tfobid ORDER BY t.effdate DESC) AS rn
      FROM afw_143fobgeninformk t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_143interesttype (nteresttype detail (name-derived, needs review), ~74 rows)
  "143interesttype": `
    SELECT t.polid, t.lobid, t.tintid, t.effdate, t.status, t.iscommoncarrier, t.iscontractcarrier, t.ispropertyshipper, t.isother, t.otherdesc, t.istransportation, t.ismtrtrkliability, t.isopen, t.isannual, t.othertypedesc, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.tintid, t.effdate, t.status, t.iscommoncarrier, t.iscontractcarrier, t.ispropertyshipper, t.isother, t.otherdesc, t.istransportation, t.ismtrtrkliability, t.isopen, t.isannual, t.othertypedesc, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.tintid ORDER BY t.effdate DESC) AS rn
      FROM afw_143interesttype t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_143mtccommodity (tccommodity detail (name-derived, needs review), ~0 rows)
  "143mtccommodity": `
    SELECT t.polid, t.lobid, t.tintid, t.tmllid, t.tcomid, t.effdate, t.status, t.targetcommodity, t.grossrevenuepct, t.maxvalue, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.tintid, t.tmllid, t.tcomid, t.effdate, t.status, t.targetcommodity, t.grossrevenuepct, t.maxvalue, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.tintid, t.tmllid, t.tcomid ORDER BY t.effdate DESC) AS rn
      FROM afw_143mtccommodity t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_143mtclegalliability (tclegalliability detail (name-derived, needs review), ~0 rows)
  "143mtclegalliability": `
    SELECT t.polid, t.lobid, t.tintid, t.tmllid, t.effdate, t.status, t.isingleconveyance, t.vsingleconveyance, t.iperdisaster, t.vperdisaster, t.iloadinglimit, t.vloadinglimit, t.loadingded, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.tintid, t.tmllid, t.effdate, t.status, t.isingleconveyance, t.vsingleconveyance, t.iperdisaster, t.vperdisaster, t.iloadinglimit, t.vloadinglimit, t.loadingded, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.tintid, t.tmllid ORDER BY t.effdate DESC) AS rn
      FROM afw_143mtclegalliability t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_143mtcoperation (tcoperation detail (name-derived, needs review), ~0 rows)
  "143mtcoperation": `
    SELECT t.polid, t.lobid, t.tintid, t.tmllid, t.tmtcid, t.effdate, t.status, t.prophauled, t.receiptpast12mo, t.receiptnext12mo, t.territory, t.avgdistance, t.maxdistance, t.nooftrucks, t.nooftractors, t.nooftrailers, t.nooftanktrailers, t.noofrefrigunits, t.specunits, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.tintid, t.tmllid, t.tmtcid, t.effdate, t.status, t.prophauled, t.receiptpast12mo, t.receiptnext12mo, t.territory, t.avgdistance, t.maxdistance, t.nooftrucks, t.nooftractors, t.nooftrailers, t.nooftanktrailers, t.noofrefrigunits, t.specunits, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.tintid, t.tmllid, t.tmtcid ORDER BY t.effdate DESC) AS rn
      FROM afw_143mtcoperation t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_143mtcstatefiling (tcstatefiling detail (name-derived, needs review), ~0 rows)
  "143mtcstatefiling": `
    SELECT t.polid, t.lobid, t.tintid, t.tmllid, t.tmtcid, t.tmsfid, t.effdate, t.status, t.stateswithfiling, t.isdocketno, t.docketno, t.isiccfiling, t.iccdocketno, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.tintid, t.tmllid, t.tmtcid, t.tmsfid, t.effdate, t.status, t.stateswithfiling, t.isdocketno, t.docketno, t.isiccfiling, t.iccdocketno, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.tintid, t.tmllid, t.tmtcid, t.tmsfid ORDER BY t.effdate DESC) AS rn
      FROM afw_143mtcstatefiling t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_143terminal (erminal detail (name-derived, needs review), ~0 rows)
  "143terminal": `
    SELECT t.polid, t.lobid, t.tintid, t.tmllid, t.ttermid, t.effdate, t.status, t.locno, t.imlocid, t.addr1, t.addr2, t.city, t.county, t.state, t.zipcode, t.avgval, t.maxval, t.iliablimit, t.vliablimit, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.tintid, t.tmllid, t.ttermid, t.effdate, t.status, t.locno, t.imlocid, t.addr1, t.addr2, t.city, t.county, t.state, t.zipcode, t.avgval, t.maxval, t.iliablimit, t.vliablimit, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.tintid, t.tmllid, t.ttermid ORDER BY t.effdate DESC) AS rn
      FROM afw_143terminal t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_143transconveyance (ransconveyance detail (name-derived, needs review), ~0 rows)
  "143transconveyance": `
    SELECT t.polid, t.lobid, t.tintid, t.tconid, t.effdate, t.status, t.conveyance, t.incoming, t.outgoing, t.interplant, t.shipmentavgval, t.iliabilitylimit, t.vliabilitylimit, t.isfullval, t.releasedval, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.tintid, t.tconid, t.effdate, t.status, t.conveyance, t.incoming, t.outgoing, t.interplant, t.shipmentavgval, t.iliabilitylimit, t.vliabilitylimit, t.isfullval, t.releasedval, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.tintid, t.tconid ORDER BY t.effdate DESC) AS rn
      FROM afw_143transconveyance t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_143transoperation (ransoperation detail (name-derived, needs review), ~0 rows)
  "143transoperation": `
    SELECT t.polid, t.lobid, t.tintid, t.ttrnid, t.effdate, t.status, t.propshipped, t.originpts, t.destpts, t.territory, t.annualgross, t.nooftrucks, t.nooftractors, t.nooftrailers, t.nooftanktrucks, t.noofrefrigunits, t.specunits, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.tintid, t.ttrnid, t.effdate, t.status, t.propshipped, t.originpts, t.destpts, t.territory, t.annualgross, t.nooftrucks, t.nooftractors, t.nooftrailers, t.nooftanktrucks, t.noofrefrigunits, t.specunits, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.tintid, t.ttrnid ORDER BY t.effdate DESC) AS rn
      FROM afw_143transoperation t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_144glass (lass detail (name-derived, needs review), ~0 rows)
  "144glass": `
    SELECT t.polid, t.lobid, t.gsglaid, t.effdate, t.status, t.clocid, t.cbldgid, t.itemno, t.plateqty, t.platelength, t.platewidth, t.platearea, t.description, t.useposition, t.ilimit, t.vlimit, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.gsglaid, t.effdate, t.status, t.clocid, t.cbldgid, t.itemno, t.plateqty, t.platelength, t.platewidth, t.platearea, t.description, t.useposition, t.ilimit, t.vlimit, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.gsglaid ORDER BY t.effdate DESC) AS rn
      FROM afw_144glass t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_144sign (ign detail (name-derived, needs review), ~0 rows)
  "144sign": `
    SELECT t.polid, t.lobid, t.gssigid, t.effdate, t.status, t.clocid, t.cbldgid, t.itemno, t.insideoutside, t.description, t.ilimit, t.vlimit, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.gssigid, t.effdate, t.status, t.clocid, t.cbldgid, t.itemno, t.insideoutside, t.description, t.ilimit, t.vlimit, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.gssigid ORDER BY t.effdate DESC) AS rn
      FROM afw_144sign t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_145account (ccount detail (name-derived, needs review), ~0 rows)
  "145account": `
    SELECT t.polid, t.lobid, t.acactid, t.effdate, t.status, t.statepct, t.year1, t.amount1, t.year2, t.amount2, t.year3, t.amount3, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.acactid, t.effdate, t.status, t.statepct, t.year1, t.amount1, t.year2, t.amount2, t.year3, t.amount3, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.acactid ORDER BY t.effdate DESC) AS rn
      FROM afw_145account t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_145bldgconstruction (ldgconstruction detail (name-derived, needs review), ~0 rows)
  "145bldgconstruction": `
    SELECT t.polid, t.lobid, t.aclocid, t.acbcid, t.effdate, t.status, t.bldgconst, t.issprinklers, t.isretail, t.retailpct, t.iswholesale, t.wholesalepct, t.ismanuf, t.manufpct, t.isinsurance, t.insurancepct, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.aclocid, t.acbcid, t.effdate, t.status, t.bldgconst, t.issprinklers, t.isretail, t.retailpct, t.iswholesale, t.wholesalepct, t.ismanuf, t.manufpct, t.isinsurance, t.insurancepct, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.aclocid, t.acbcid ORDER BY t.effdate DESC) AS rn
      FROM afw_145bldgconstruction t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_145location (ocation detail (name-derived, needs review), ~0 rows)
  "145location": `
    SELECT t.polid, t.lobid, t.imlocid, t.aclocid, t.effdate, t.status, t.isvalpapers, t.isacctreceivable, t.ispapersreplaced, t.basis, t.specifiedamt, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.imlocid, t.aclocid, t.effdate, t.status, t.isvalpapers, t.isacctreceivable, t.ispapersreplaced, t.basis, t.specifiedamt, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imlocid, t.aclocid ORDER BY t.effdate DESC) AS rn
      FROM afw_145location t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_145papers (apers detail (name-derived, needs review), ~0 rows)
  "145papers": `
    SELECT t.polid, t.lobid, t.acpapid, t.effdate, t.status, t.paperdesc, t.paperno, t.specifiedamt, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.acpapid, t.effdate, t.status, t.paperdesc, t.paperno, t.specifiedamt, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.acpapid ORDER BY t.effdate DESC) AS rn
      FROM afw_145papers t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_145receivables (eceivables detail (name-derived, needs review), ~0 rows)
  "145receivables": `
    SELECT t.polid, t.lobid, t.acrecid, t.effdate, t.status, t.monthyear, t.acctrecamt, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.acrecid, t.effdate, t.status, t.monthyear, t.acctrecamt, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.acrecid ORDER BY t.effdate DESC) AS rn
      FROM afw_145receivables t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_145recordlocation (ecordlocation detail (name-derived, needs review), ~0 rows) -- API-UNAVAILABLE: Data Lake API 404/500s on this table regardless of tenant (confirmed 2026-09-01), will stay empty regardless of grant status
  "145recordlocation": `
    SELECT t.polid, t.lobid, t.aclocid, t.acrlid, t.effdate, t.status, t.locaddr, t.bldgsection, t.firecontentpct, t.isdupreckept, t.dupreccpct, t.addr1, t.addr2, t.city, t.state, t.zip, t.receptacles, t.periodreckept, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.aclocid, t.acrlid, t.effdate, t.status, t.locaddr, t.bldgsection, t.firecontentpct, t.isdupreckept, t.dupreccpct, t.addr1, t.addr2, t.city, t.state, t.zip, t.receptacles, t.periodreckept, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.aclocid, t.acrlid ORDER BY t.effdate DESC) AS rn
      FROM afw_145recordlocation t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_145safeprotection (afeprotection detail (name-derived, needs review), ~0 rows)
  "145safeprotection": `
    SELECT t.polid, t.lobid, t.acsafid, t.effdate, t.status, t.attachid, t.attachtype, t.alarmtype, t.alarmdesc, t.grade, t.extentofprotection, t.alarminstallby, t.noofguards, t.noofwatch, t.watchpersons, t.certno, t.certexpdate, t.accessopenprotect, t.otherprotect, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.acsafid, t.effdate, t.status, t.attachid, t.attachtype, t.alarmtype, t.alarmdesc, t.grade, t.extentofprotection, t.alarminstallby, t.noofguards, t.noofwatch, t.watchpersons, t.certno, t.certexpdate, t.accessopenprotect, t.otherprotect, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.acsafid ORDER BY t.effdate DESC) AS rn
      FROM afw_145safeprotection t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_145vault (ault detail (name-derived, needs review), ~0 rows)
  "145vault": `
    SELECT t.polid, t.lobid, t.acvauid, t.effdate, t.status, t.attachid, t.attachtype, t.manufacturer, t.label, t.class, t.door, t.outerlock, t.innerlock, t.chestlock, t.doorthickness, t.wallthickness, t.construction, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.acvauid, t.effdate, t.status, t.attachid, t.attachtype, t.manufacturer, t.label, t.class, t.door, t.outerlock, t.innerlock, t.chestlock, t.doorthickness, t.wallthickness, t.construction, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.acvauid ORDER BY t.effdate DESC) AS rn
      FROM afw_145vault t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_146equipfloater (quipfloater detail (name-derived, needs review), ~770 rows)
  "146equipfloater": `
    SELECT t.polid, t.lobid, t.imefid, t.effdate, t.status, t.territory, t.type, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.imefid, t.effdate, t.status, t.territory, t.type, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imefid ORDER BY t.effdate DESC) AS rn
      FROM afw_146equipfloater t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_146equipsummary (quipsummary detail (name-derived, needs review), ~3998 rows)
  "146equipsummary": `
    SELECT t.polid, t.lobid, t.imefid, t.imesumid, t.effdate, t.status, t.imlocid, t.category, t.subcategory, t.defaultvaluetype, t.coinspct, t.totalitems, t.amtofins, t.schedulecode, t.cpremid, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.imefid, t.imesumid, t.effdate, t.status, t.imlocid, t.category, t.subcategory, t.defaultvaluetype, t.coinspct, t.totalitems, t.amtofins, t.schedulecode, t.cpremid, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imefid, t.imesumid ORDER BY t.effdate DESC) AS rn
      FROM afw_146equipsummary t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_146locations (ocations detail (name-derived, needs review), ~2103 rows)
  "146locations": `
    SELECT t.polid, t.lobid, t.imlocid, t.effdate, t.status, t.clocid, t.cbldgid, t.locno, t.bldgno, t.addr1, t.addr2, t.city, t.state, t.zip, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.imlocid, t.effdate, t.status, t.clocid, t.cbldgid, t.locno, t.bldgno, t.addr1, t.addr2, t.city, t.state, t.zip, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imlocid ORDER BY t.effdate DESC) AS rn
      FROM afw_146locations t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_146schedequip (chedequip detail (name-derived, needs review), ~5548 rows)
  "146schedequip": `
    SELECT t.polid, t.lobid, t.imefid, t.imesumid, t.imseid, t.effdate, t.status, t.equipno, t.equipdesc, t.equipcustno, t.vinsamt, t.iinsamt, t.manufacturer, t.model, t.modelyr, t.serialno, t.capacity, t.newused, t.ownership, t.purchasedate, t.valuedate, t.valuetype, t.value, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.imefid, t.imesumid, t.imseid, t.effdate, t.status, t.equipno, t.equipdesc, t.equipcustno, t.vinsamt, t.iinsamt, t.manufacturer, t.model, t.modelyr, t.serialno, t.capacity, t.newused, t.ownership, t.purchasedate, t.valuedate, t.valuetype, t.value, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imefid, t.imesumid, t.imseid ORDER BY t.effdate DESC) AS rn
      FROM afw_146schedequip t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_146storage (torage detail (name-derived, needs review), ~3 rows)
  "146storage": `
    SELECT t.polid, t.lobid, t.imefid, t.imstrid, t.effdate, t.status, t.imlocid, t.moinstorage, t.inbuilding, t.outside, t.securitytype, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.imefid, t.imstrid, t.effdate, t.status, t.imlocid, t.moinstorage, t.inbuilding, t.outside, t.securitytype, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imefid, t.imstrid ORDER BY t.effdate DESC) AS rn
      FROM afw_146storage t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_146unschedequip (nschedequip detail (name-derived, needs review), ~188 rows)
  "146unschedequip": `
    SELECT t.polid, t.lobid, t.imefid, t.imesumid, t.imuseid, t.effdate, t.status, t.equipdesc, t.vmaxitem, t.imaxitem, t.vinsamt, t.iinsamt, t.coinspct, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.imefid, t.imesumid, t.imuseid, t.effdate, t.status, t.equipdesc, t.vmaxitem, t.imaxitem, t.vinsamt, t.iinsamt, t.coinspct, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imefid, t.imesumid, t.imuseid ORDER BY t.effdate DESC) AS rn
      FROM afw_146unschedequip t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_147builderoperation (uilderoperation detail (name-derived, needs review), ~366 rows)
  "147builderoperation": `
    SELECT t.polid, t.lobid, t.imboid, t.effdate, t.status, t.imlocid, t.reportingform, t.reportingperiod, t.territory, t.receiptpast12mo, t.receiptnext12mo, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.imboid, t.effdate, t.status, t.imlocid, t.reportingform, t.reportingperiod, t.territory, t.receiptpast12mo, t.receiptnext12mo, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imboid ORDER BY t.effdate DESC) AS rn
      FROM afw_147builderoperation t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_147jobvalue (obvalue detail (name-derived, needs review), ~4 rows)
  "147jobvalue": `
    SELECT t.polid, t.lobid, t.imboid, t.imvalid, t.effdate, t.status, t.jobtype, t.annualnoofjobs, t.jobduration, t.maxnoofjobs, t.avnoofjobs, t.maxcost, t.mincost, t.avcost, t.materialcostpct, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.imboid, t.imvalid, t.effdate, t.status, t.jobtype, t.annualnoofjobs, t.jobduration, t.maxnoofjobs, t.avnoofjobs, t.maxcost, t.mincost, t.avcost, t.materialcostpct, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imboid, t.imvalid ORDER BY t.effdate DESC) AS rn
      FROM afw_147jobvalue t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_147rigtranssecurity (igtranssecurity detail (name-derived, needs review), ~0 rows)
  "147rigtranssecurity": `
    SELECT t.polid, t.lobid, t.imboid, t.imrigid, t.effdate, t.status, t.imsjid, t.jobno, t.rigging, t.shippct, t.sitesecurity, t.amtshipped, t.insdvehpct, t.carrierpct, t.distance, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.imboid, t.imrigid, t.effdate, t.status, t.imsjid, t.jobno, t.rigging, t.shippct, t.sitesecurity, t.amtshipped, t.insdvehpct, t.carrierpct, t.distance, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imboid, t.imrigid ORDER BY t.effdate DESC) AS rn
      FROM afw_147rigtranssecurity t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_147specificjob (pecificjob detail (name-derived, needs review), ~23 rows)
  "147specificjob": `
    SELECT t.polid, t.lobid, t.imboid, t.imsjid, t.effdate, t.status, t.commencedate, t.completiondate, t.valownersuppliedprop, t.contractamt, t.jobdesc, t.custjobno, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.imboid, t.imsjid, t.effdate, t.status, t.commencedate, t.completiondate, t.valownersuppliedprop, t.contractamt, t.jobdesc, t.custjobno, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.imboid, t.imsjid ORDER BY t.effdate DESC) AS rn
      FROM afw_147specificjob t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_148mediainfo (ediainfo detail (name-derived, needs review), ~0 rows)
  "148mediainfo": `
    SELECT t.polid, t.lobid, t.piid, t.dpmiid, t.effdate, t.status, t.answer1, t.answer2, t.isdaily, t.isweekly, t.ismonthly, t.isquarterly, t.isyearly, t.isbackupother, t.backupother, t.issoftware, t.isbackups, t.issafe, t.isvault, t.iscomputerroom, t.isonpremother, t.onpremother, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.piid, t.dpmiid, t.effdate, t.status, t.answer1, t.answer2, t.isdaily, t.isweekly, t.ismonthly, t.isquarterly, t.isyearly, t.isbackupother, t.backupother, t.issoftware, t.isbackups, t.issafe, t.isvault, t.iscomputerroom, t.isonpremother, t.onpremother, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.piid, t.dpmiid ORDER BY t.effdate DESC) AS rn
      FROM afw_148mediainfo t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_148schedule (chedule detail (name-derived, needs review), ~13 rows)
  "148schedule": `
    SELECT t.polid, t.lobid, t.piid, t.dpschid, t.effdate, t.status, t.itemno, t.category, t.manufacturer, t.model, t.serialno, t.leased, t.fullvalue, t.amountofins, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.piid, t.dpschid, t.effdate, t.status, t.itemno, t.category, t.manufacturer, t.model, t.serialno, t.leased, t.fullvalue, t.amountofins, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.piid, t.dpschid ORDER BY t.effdate DESC) AS rn
      FROM afw_148schedule t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_148underwriting (nderwriting detail (name-derived, needs review), ~0 rows)
  "148underwriting": `
    SELECT t.polid, t.lobid, t.piid, t.dpuwid, t.effdate, t.status, t.answer1, t.answer2, t.answer3, t.answer4, t.isnone, t.iswetsprinkler, t.isdrysprinkler, t.ishalon, t.isco2, t.isprotectother, t.protectother, t.answer6, t.iscombustible, t.issmoke, t.isbelowhalon, t.isbelowother, t.belowother, t.isbelownone, t.tempalarmtype, t.humidityalarmtype, t.smokealarmtype, t.firealarmtype, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.piid, t.dpuwid, t.effdate, t.status, t.answer1, t.answer2, t.answer3, t.answer4, t.isnone, t.iswetsprinkler, t.isdrysprinkler, t.ishalon, t.isco2, t.isprotectother, t.protectother, t.answer6, t.iscombustible, t.issmoke, t.isbelowhalon, t.isbelowother, t.belowother, t.isbelownone, t.tempalarmtype, t.humidityalarmtype, t.smokealarmtype, t.firealarmtype, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.piid, t.dpuwid ORDER BY t.effdate DESC) AS rn
      FROM afw_148underwriting t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_834technologyservices (echnologyservices detail (name-derived, needs review), ~0 rows) -- API-UNAVAILABLE: Data Lake API 404/500s on this table regardless of tenant (confirmed 2026-09-01), will stay empty regardless of grant status
  "834technologyservices": `
    SELECT t.technologyservicesid, t.polid, t.lobid, t.serviceid, t.effdate, t.status, t.service, t.description, t.projectedrevenue, t.changedby, t.changeddate, t.enteredby, t.entereddate
    FROM (
      SELECT t.technologyservicesid, t.polid, t.lobid, t.serviceid, t.effdate, t.status, t.service, t.description, t.projectedrevenue, t.changedby, t.changeddate, t.enteredby, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.technologyservicesid ORDER BY t.effdate DESC) AS rn
      FROM afw_834technologyservices t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_annualpol (annualpol detail (name-derived, needs review), ~0 rows)
  "annualpol": `
    SELECT t.polid, t.lobid, t.anid, t.effdate, t.status, t.motorcycle, t.trailer, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.anid, t.effdate, t.status, t.motorcycle, t.trailer, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.anid ORDER BY t.effdate DESC) AS rn
      FROM afw_annualpol t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_applicantphonemap (applicantphonemap detail (name-derived, needs review), ~0 rows) -- API-UNAVAILABLE: Data Lake API 404/500s on this table regardless of tenant (confirmed 2026-09-01), will stay empty regardless of grant status
  "applicantphonemap": `
    SELECT t.attachid, t.polid, t.appid, t.effdate
    FROM (
      SELECT t.attachid, t.polid, t.appid, t.effdate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.attachid, t.appid ORDER BY t.effdate DESC) AS rn
      FROM afw_applicantphonemap t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1
    ORDER BY t.polid
  `,

  // afw_attachment (attachment detail (name-derived, needs review), ~0 rows)
  "attachment": `
    SELECT t.polid, t.lobid, t.attachid, t.attachtype, t.attachmentid, t.effdate, t.status, t.attachedform, t.description, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.attachid, t.attachtype, t.attachmentid, t.effdate, t.status, t.attachedform, t.description, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.attachmentid ORDER BY t.effdate DESC) AS rn
      FROM afw_attachment t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_boat (boat detail (name-derived, needs review), ~414 rows)
  "boat": `
    SELECT t.polid, t.lobid, t.boatid, t.bsumid, t.effdate, t.status, t.num, t.conum, t.propulsion, t.hulltype, t.hullmaterial, t.hulldesign, t.fueltank, t.registration, t.hullnum, t.modelyear, t.makemodel, t.length, t.maxspeed, t.purchasedate, t.costnew, t.presentvalue, t.boatname, t.watersnavi, t.territory, t.berthaddr1, t.berthaddr2, t.berthcity, t.berthstate, t.berthzip, t.beginlayup, t.endlayup, t.storagetype, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.boatid, t.bsumid, t.effdate, t.status, t.num, t.conum, t.propulsion, t.hulltype, t.hullmaterial, t.hulldesign, t.fueltank, t.registration, t.hullnum, t.modelyear, t.makemodel, t.length, t.maxspeed, t.purchasedate, t.costnew, t.presentvalue, t.boatname, t.watersnavi, t.territory, t.berthaddr1, t.berthaddr2, t.berthcity, t.berthstate, t.berthzip, t.beginlayup, t.endlayup, t.storagetype, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.bsumid, t.boatid ORDER BY t.effdate DESC) AS rn
      FROM afw_boat t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_boatengine (boatengine detail (name-derived, needs review), ~142 rows)
  "boatengine": `
    SELECT t.polid, t.lobid, t.bengid, t.bsumid, t.effdate, t.status, t.motorno, t.comotorno, t.modelyear, t.makemodel, t.serialno, t.horsepower, t.fuel, t.datepurchased, t.costnew, t.presentvalue, t.other, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.bengid, t.bsumid, t.effdate, t.status, t.motorno, t.comotorno, t.modelyear, t.makemodel, t.serialno, t.horsepower, t.fuel, t.datepurchased, t.costnew, t.presentvalue, t.other, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.bsumid, t.bengid ORDER BY t.effdate DESC) AS rn
      FROM afw_boatengine t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_boatequipment (boatequipment detail (name-derived, needs review), ~4 rows)
  "boatequipment": `
    SELECT t.polid, t.lobid, t.beqipid, t.bsumid, t.effdate, t.status, t.type, t.qty, t.makemodel, t.serialno, t.presentvalue, t.modelyear, t.model, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.beqipid, t.bsumid, t.effdate, t.status, t.type, t.qty, t.makemodel, t.serialno, t.presentvalue, t.modelyear, t.model, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.bsumid, t.beqipid ORDER BY t.effdate DESC) AS rn
      FROM afw_boatequipment t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_boatexperience (boatexperience detail (name-derived, needs review), ~0 rows)
  "boatexperience": `
    SELECT t.polid, t.lobid, t.bexpid, t.effdate, t.status, t.experiencebexp, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.bexpid, t.effdate, t.status, t.experiencebexp, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.bexpid ORDER BY t.effdate DESC) AS rn
      FROM afw_boatexperience t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_boatoperator (boatoperator detail (name-derived, needs review), ~615 rows)
  "boatoperator": `
    SELECT t.polid, t.lobid, t.boperid, t.effdate, t.status, t.boperno, t.firstname, t.lastname, t.sex, t.maritalstatus, t.licensestate, t.experience, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.boperid, t.effdate, t.status, t.boperno, t.firstname, t.lastname, t.sex, t.maritalstatus, t.licensestate, t.experience, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.boperid ORDER BY t.effdate DESC) AS rn
      FROM afw_boatoperator t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_boatsummary (boatsummary detail (name-derived, needs review), ~337 rows)
  "boatsummary": `
    SELECT t.polid, t.lobid, t.bsumid, t.effdate, t.status, t.totalcredits, t.totalprem, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.bsumid, t.effdate, t.status, t.totalcredits, t.totalprem, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.bsumid ORDER BY t.effdate DESC) AS rn
      FROM afw_boatsummary t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_boattrailer (boattrailer detail (name-derived, needs review), ~207 rows)
  "boattrailer": `
    SELECT t.polid, t.lobid, t.btrlid, t.bsumid, t.effdate, t.status, t.trailerno, t.cotrailerno, t.trlryear, t.manumodel, t.serialno, t.noaxles, t.capacity, t.datepurchased, t.costnew, t.presentvalue, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.btrlid, t.bsumid, t.effdate, t.status, t.trailerno, t.cotrailerno, t.trlryear, t.manumodel, t.serialno, t.noaxles, t.capacity, t.datepurchased, t.costnew, t.presentvalue, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.bsumid, t.btrlid ORDER BY t.effdate DESC) AS rn
      FROM afw_boattrailer t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_building (building detail (name-derived, needs review), ~87 rows)
  "building": `
    SELECT t.polid, t.lobid, t.locid, t.coverageid, t.bldgid, t.effdate, t.status, t.bldgno, t.description, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.locid, t.coverageid, t.bldgid, t.effdate, t.status, t.bldgno, t.description, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.coverageid, t.bldgid ORDER BY t.effdate DESC) AS rn
      FROM afw_building t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_cbuilding (Commercial building/property detail, ~10374 rows)
  "cbuilding": `
    SELECT t.polid, t.cbldgid, t.effdate, t.clocid, t.status, t.bldgno, t.description, t.citylimits, t.interest, t.yearbuilt, t.partoccupied, t.sameasloc, t.addr1, t.addr2, t.county, t.city, t.state, t.zip, t.numofemployees, t.noofempfull, t.noofemppart, t.pctoccupied, t.annrevenues, t.totalbldgarea, t.occupiedarea, t.areaopntopub, t.isleasedtooth, t.bldgdescofops, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.cbldgid, t.effdate, t.clocid, t.status, t.bldgno, t.description, t.citylimits, t.interest, t.yearbuilt, t.partoccupied, t.sameasloc, t.addr1, t.addr2, t.county, t.city, t.state, t.zip, t.numofemployees, t.noofempfull, t.noofemppart, t.pctoccupied, t.annrevenues, t.totalbldgarea, t.occupiedarea, t.areaopntopub, t.isleasedtooth, t.bldgdescofops, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.clocid, t.cbldgid ORDER BY t.effdate DESC) AS rn
      FROM afw_cbuilding t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid
  `,

  // afw_cform (Forms attached to a policy/LOB (generic, cross-LOB), ~261544 rows)
  "cform": `
    SELECT t.polid, t.lobid, t.cfrmid, t.effdate, t.status, t.formno, t.editiondate, t.description, t.description2, t.attachid, t.attachtype, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.cfrmid, t.effdate, t.status, t.formno, t.editiondate, t.description, t.description2, t.attachid, t.attachtype, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.cfrmid ORDER BY t.effdate DESC) AS rn
      FROM afw_cform t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_clocation (Commercial policy location schedule, ~11488 rows)
  "clocation": `
    SELECT t.polid, t.clocid, t.effdate, t.status, t.locno, t.addr1, t.addr2, t.county, t.city, t.state, t.zip, t.isforeign, t.countrycode, t.annrevenues, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.clocid, t.effdate, t.status, t.locno, t.addr1, t.addr2, t.county, t.city, t.state, t.zip, t.isforeign, t.countrycode, t.annrevenues, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.clocid ORDER BY t.effdate DESC) AS rn
      FROM afw_clocation t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid
  `,

  // afw_cnamedinsured (cnamedinsured detail (name-derived, needs review), ~2311 rows)
  "cnamedinsured": `
    SELECT t.polid, t.cniid, t.effdate, t.status, t.namedins, t.insuredtype, t.entitytype, t.busareacode, t.busphone, t.busext, t.altareacode, t.altphone, t.altext, t.faxareacodecni, t.faxphonecni, t.faxextcni, t.cellareacodecni, t.cellphonecni, t.cellextcni, t.emailcni, t.polscid, t.glcode, t.sic, t.naics, t.fedempno, t.webaddr, t.numofmembers, t.mailaddr1, t.mailaddr2, t.mailcity, t.mailstate, t.mailzip, t.mailcounty, t.countrycode, t.isforeign, t.changedby, t.changeddate, t.entereddate, t.note
    FROM (
      SELECT t.polid, t.cniid, t.effdate, t.status, t.namedins, t.insuredtype, t.entitytype, t.busareacode, t.busphone, t.busext, t.altareacode, t.altphone, t.altext, t.faxareacodecni, t.faxphonecni, t.faxextcni, t.cellareacodecni, t.cellphonecni, t.cellextcni, t.emailcni, t.polscid, t.glcode, t.sic, t.naics, t.fedempno, t.webaddr, t.numofmembers, t.mailaddr1, t.mailaddr2, t.mailcity, t.mailstate, t.mailzip, t.mailcounty, t.countrycode, t.isforeign, t.changedby, t.changeddate, t.entereddate, t.note,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.cniid ORDER BY t.effdate DESC) AS rn
      FROM afw_cnamedinsured t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid
  `,

  // afw_cnamedinsuredphonemap (cnamedinsuredphonemap detail (name-derived, needs review), ~1337 rows)
  "cnamedinsuredphonemap": `
    SELECT t.attachid, t.polid, t.cniid, t.effdate
    FROM (
      SELECT t.attachid, t.polid, t.cniid, t.effdate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.attachid ORDER BY t.effdate DESC) AS rn
      FROM afw_cnamedinsuredphonemap t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1
    ORDER BY t.polid
  `,

  // afw_coinsured (coinsured detail (name-derived, needs review), ~9641 rows)
  "coinsured": `
    SELECT t.polid, t.coinid, t.effdate, t.status, t.lastname, t.firstname, t.midname, t.resareacode, t.resphone, t.resext, t.busareacode, t.busphone, t.busext, t.occupation, t.yearemployed, t.married, t.emprname, t.empraddr1, t.empraddr2, t.emprcity, t.emprstate, t.isforeign, t.countrycode, t.emprzipcode, t.curroccsince, t.yearsprioremp, t.faxareacodecoin, t.faxphonecoin, t.faxextcoin, t.cellareacodecoin, t.cellphonecoin, t.cellextcoin, t.emailcoin, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.coinid, t.effdate, t.status, t.lastname, t.firstname, t.midname, t.resareacode, t.resphone, t.resext, t.busareacode, t.busphone, t.busext, t.occupation, t.yearemployed, t.married, t.emprname, t.empraddr1, t.empraddr2, t.emprcity, t.emprstate, t.isforeign, t.countrycode, t.emprzipcode, t.curroccsince, t.yearsprioremp, t.faxareacodecoin, t.faxphonecoin, t.faxextcoin, t.cellareacodecoin, t.cellphonecoin, t.cellextcoin, t.emailcoin, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.coinid ORDER BY t.effdate DESC) AS rn
      FROM afw_coinsured t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid
  `,

  // afw_coinsuredphonemap (coinsuredphonemap detail (name-derived, needs review), ~8893 rows)
  "coinsuredphonemap": `
    SELECT t.attachid, t.polid, t.coinid, t.effdate
    FROM (
      SELECT t.attachid, t.polid, t.coinid, t.effdate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.attachid ORDER BY t.effdate DESC) AS rn
      FROM afw_coinsuredphonemap t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1
    ORDER BY t.polid
  `,

  // afw_commaddotherint (Additional interest info (commercial), ~14653 rows)
  "commaddotherint": `
    SELECT t.polid, t.lobid, t.caoiid, t.effdate, t.status, t.attachid, t.attachtype, t.name1, t.name2, t.addr1, t.addr2, t.city, t.state, t.zip, t.rank, t.refno, t.certreq, t.clocid, t.cbldgid, t.other, t.itemdesc, t.areacode, t.phone, t.ext, t.faxareacode, t.faxphone, t.faxext, t.emailcaoi, t.ispayor, t.interest, t.certissued, t.certreqdate, t.certissueddate, t.polreq, t.polreqdate, t.polissued, t.polissueddate, t.finalpaydatecaoi, t.contactcaoi, t.farmitemid, t.refid, t.reftype, t.descofops, t.jobtype, t.jobno, t.projectenddate, t.islicensed, t.isbonded, t.noofdays, t.isxoutendeavor, t.isxoutfailure, t.isxoutworkcomp, t.methodofdelivery, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.caoiid, t.effdate, t.status, t.attachid, t.attachtype, t.name1, t.name2, t.addr1, t.addr2, t.city, t.state, t.zip, t.rank, t.refno, t.certreq, t.clocid, t.cbldgid, t.other, t.itemdesc, t.areacode, t.phone, t.ext, t.faxareacode, t.faxphone, t.faxext, t.emailcaoi, t.ispayor, t.interest, t.certissued, t.certreqdate, t.certissueddate, t.polreq, t.polreqdate, t.polissued, t.polissueddate, t.finalpaydatecaoi, t.contactcaoi, t.farmitemid, t.refid, t.reftype, t.descofops, t.jobtype, t.jobno, t.projectenddate, t.islicensed, t.isbonded, t.noofdays, t.isxoutendeavor, t.isxoutfailure, t.isxoutworkcomp, t.methodofdelivery, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.caoiid ORDER BY t.effdate DESC) AS rn
      FROM afw_commaddotherint t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_compspecanswer (compspecanswer detail (name-derived, needs review), ~0 rows) -- NO DEDUP: no effdate + own-PK combo found, plain select, confirmed 1:1/non-historized for some of these (peer review 2026-09-01), verify the rest before assuming
  "compspecanswer": `
    SELECT t.csqrid, t.polid, t.lobid, t.answer, t.changedby, t.changeddate, t.entereddate
    FROM afw_compspecanswer t
    WHERE t.polid = ANY($1::uuid[])
    ORDER BY t.polid, t.lobid
  `,

  // afw_conviction (conviction detail (name-derived, needs review), ~24 rows)
  "conviction": `
    SELECT t.polid, t.lobid, t.convid, t.effdate, t.status, t.isconv, t.noofyears, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.convid, t.effdate, t.status, t.isconv, t.noofyears, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.convid ORDER BY t.effdate DESC) AS rn
      FROM afw_conviction t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_coveragehome (coveragehome detail (name-derived, needs review), ~3049 rows)
  "coveragehome": `
    SELECT t.polid, t.lobid, t.chomid, t.coverageid, t.locid, t.effdate, t.status, t.yesnoindicator, t.structuretype, t.materialtype, t.credit, t.nooffamilies, t.sqfootage, t.noofplates, t.liability, t.noofchildren, t.noofemployees, t.chomzone, t.coverageform, t.addr1, t.addr2, t.city, t.state, t.zip, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.chomid, t.coverageid, t.locid, t.effdate, t.status, t.yesnoindicator, t.structuretype, t.materialtype, t.credit, t.nooffamilies, t.sqfootage, t.noofplates, t.liability, t.noofchildren, t.noofemployees, t.chomzone, t.coverageform, t.addr1, t.addr2, t.city, t.state, t.zip, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.coverageid, t.locid, t.chomid ORDER BY t.effdate DESC) AS rn
      FROM afw_coveragehome t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_covoption (Coverage option detail, ~11348 rows)
  "covoption": `
    SELECT t.polid, t.lobid, t.coverageid, t.coptid, t.effdate, t.status, t.description, t.optionno, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.coverageid, t.coptid, t.effdate, t.status, t.description, t.optionno, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.coverageid, t.coptid ORDER BY t.effdate DESC) AS rn
      FROM afw_covoption t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_cpremtotal (cpremtotal detail (name-derived, needs review), ~2544 rows)
  "cpremtotal": `
    SELECT t.polid, t.lobid, t.cptid, t.effdate, t.status, t.attachid, t.attachtype, t.totalprem, t.totalgroup, t.defaultcovoption, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.cptid, t.effdate, t.status, t.attachid, t.attachtype, t.totalprem, t.totalgroup, t.defaultcovoption, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.cptid ORDER BY t.effdate DESC) AS rn
      FROM afw_cpremtotal t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_driveothercar (driveothercar detail (name-derived, needs review), ~520 rows)
  "driveothercar": `
    SELECT t.polid, t.lobid, t.state, t.docid, t.effdate, t.status, t.class, t.numemployed, t.numcovered, t.applies, t.isonapp, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.state, t.docid, t.effdate, t.status, t.class, t.numemployed, t.numcovered, t.applies, t.isonapp, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.docid ORDER BY t.effdate DESC) AS rn
      FROM afw_driveothercar t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_driver (driver detail (name-derived, needs review), ~9514 rows)
  "driver": `
    SELECT t.polid, t.lobid, t.drvid, t.effdate, t.status, t.driverno, t.firstname, t.midname, t.lastname, t.sex, t.licensestate, t.married, t.relation, t.occupation, t.licensedate, t.defdrvdate, t.isstudentover, t.isdrvtrain, t.isgoodstudent, t.employer, t.addr1, t.addr2, t.city, t.state, t.zip, t.yearemployed, t.yearlicensed, t.licenseclass, t.isdeferred, t.othlicensedate, t.unlicenseexclude, t.isgooddriver, t.ismaturedriver, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.drvid, t.effdate, t.status, t.driverno, t.firstname, t.midname, t.lastname, t.sex, t.licensestate, t.married, t.relation, t.occupation, t.licensedate, t.defdrvdate, t.isstudentover, t.isdrvtrain, t.isgoodstudent, t.employer, t.addr1, t.addr2, t.city, t.state, t.zip, t.yearemployed, t.yearlicensed, t.licenseclass, t.isdeferred, t.othlicensedate, t.unlicenseexclude, t.isgooddriver, t.ismaturedriver, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.drvid ORDER BY t.effdate DESC) AS rn
      FROM afw_driver t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_employer (employer detail (name-derived, needs review), ~370 rows)
  "employer": `
    SELECT t.polid, t.emprid, t.effdate, t.status, t.name, t.addr1, t.addr2, t.city, t.state, t.zipcode, t.curroccsince, t.yearsprioremp, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.emprid, t.effdate, t.status, t.name, t.addr1, t.addr2, t.city, t.state, t.zipcode, t.curroccsince, t.yearsprioremp, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.emprid ORDER BY t.effdate DESC) AS rn
      FROM afw_employer t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid
  `,

  // afw_evidenceofprop (evidenceofprop detail (name-derived, needs review), ~980 rows) -- NO DEDUP: no effdate + own-PK combo found, plain select, confirmed 1:1/non-historized for some of these (peer review 2026-09-01), verify the rest before assuming
  "evidenceofprop": `
    SELECT t.epiid, t.elfformid, t.polid, t.endeffdate, t.epino, t.descriptionepi, t.notetext, t.printnote, t.isoninternet, t.imageshortname, t.authorizedrep, t.imageid, t.sigempcode, t.changedby, t.changeddate, t.entereddate
    FROM afw_evidenceofprop t
    WHERE t.polid = ANY($1::uuid[])
    ORDER BY t.polid
  `,

  // afw_exboatcoverage (exboatcoverage detail (name-derived, needs review), ~0 rows)
  "exboatcoverage": `
    SELECT t.polid, t.lobid, t.xbcovid, t.bsumid, t.effdate, t.status, t.othercovxbcov, t.describcreditsxbcov, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.xbcovid, t.bsumid, t.effdate, t.status, t.othercovxbcov, t.describcreditsxbcov, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.bsumid, t.xbcovid ORDER BY t.effdate DESC) AS rn
      FROM afw_exboatcoverage t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_factor (factor detail (name-derived, needs review), ~4730 rows)
  "factor": `
    SELECT t.polid, t.lobid, t.cpremid, t.factid, t.effdate, t.status, t.factor, t.description, t.insertseqno, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.cpremid, t.factid, t.effdate, t.status, t.factor, t.description, t.insertseqno, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.cpremid, t.factid ORDER BY t.effdate DESC) AS rn
      FROM afw_factor t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_farmcategory (farmcategory detail (name-derived, needs review), ~6 rows)
  "farmcategory": `
    SELECT t.polid, t.lobid, t.farmcatid, t.effdate, t.status, t.category, t.clocid, t.isscheduled, t.totalvalue, t.totallimit, t.totalprem, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.farmcatid, t.effdate, t.status, t.category, t.clocid, t.isscheduled, t.totalvalue, t.totallimit, t.totalprem, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.farmcatid ORDER BY t.effdate DESC) AS rn
      FROM afw_farmcategory t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_farmexclprop (farmexclprop detail (name-derived, needs review), ~0 rows)
  "farmexclprop": `
    SELECT t.polid, t.lobid, t.farmexid, t.effdate, t.status, t.vlimitagpro, t.ilimitagpro, t.vlimitpoul, t.ilimitpoul, t.vlimitlvstk, t.ilimitlvstk, t.vlimitagmach, t.ilimitagmach, t.vlimitagtool, t.ilimitagtool, t.vlimitirrig, t.ilimitirrig, t.vlimitother, t.ilimitother, t.total, t.rate, t.premium, t.agproitem, t.poulitem, t.lvstkitem, t.agmachitem, t.agtoolitem, t.irrigitem, t.otheritem, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.farmexid, t.effdate, t.status, t.vlimitagpro, t.ilimitagpro, t.vlimitpoul, t.ilimitpoul, t.vlimitlvstk, t.ilimitlvstk, t.vlimitagmach, t.ilimitagmach, t.vlimitagtool, t.ilimitagtool, t.vlimitirrig, t.ilimitirrig, t.vlimitother, t.ilimitother, t.total, t.rate, t.premium, t.agproitem, t.poulitem, t.lvstkitem, t.agmachitem, t.agtoolitem, t.irrigitem, t.otheritem, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.farmexid ORDER BY t.effdate DESC) AS rn
      FROM afw_farmexclprop t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_farmgl (farmgl detail (name-derived, needs review), ~9 rows)
  "farmgl": `
    SELECT t.polid, t.lobid, t.farmglid, t.effdate, t.status, t.iscommgl, t.ispersaais, t.insurednames, t.iscommaais, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.farmglid, t.effdate, t.status, t.iscommgl, t.ispersaais, t.insurednames, t.iscommaais, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.farmglid ORDER BY t.effdate DESC) AS rn
      FROM afw_farmgl t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_farmitem (farmitem detail (name-derived, needs review), ~6 rows)
  "farmitem": `
    SELECT t.polid, t.lobid, t.farmitemid, t.effdate, t.status, t.farmcatid, t.itemno, t.iscustomuse, t.description, t.numofunit, t.unitprice, t.value, t.isoffprem, t.hayoffprem, t.isrvonprem, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.farmitemid, t.effdate, t.status, t.farmcatid, t.itemno, t.iscustomuse, t.description, t.numofunit, t.unitprice, t.value, t.isoffprem, t.hayoffprem, t.isrvonprem, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.farmitemid ORDER BY t.effdate DESC) AS rn
      FROM afw_farmitem t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_farmpiuw (farmpiuw detail (name-derived, needs review), ~15 rows)
  "farmpiuw": `
    SELECT t.polid, t.lobid, t.farmpiid, t.farmpiuwid, t.effdate, t.status, t.bldgtype, t.consttype, t.heattype, t.rooftype, t.yearblt, t.protclass, t.roofyr, t.totarea, t.noofstories, t.noofbase, t.hydrantdist, t.firestatdist, t.firedist, t.firecodeno, t.isboilerprem, t.isinselsewhere, t.iswoodstove, t.stovedesc, t.isalarm, t.alarmtype, t.alarmfloors, t.alarmdiagno, t.bldgimp, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.farmpiid, t.farmpiuwid, t.effdate, t.status, t.bldgtype, t.consttype, t.heattype, t.rooftype, t.yearblt, t.protclass, t.roofyr, t.totarea, t.noofstories, t.noofbase, t.hydrantdist, t.firestatdist, t.firedist, t.firecodeno, t.isboilerprem, t.isinselsewhere, t.iswoodstove, t.stovedesc, t.isalarm, t.alarmtype, t.alarmfloors, t.alarmdiagno, t.bldgimp, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.farmpiid, t.farmpiuwid ORDER BY t.effdate DESC) AS rn
      FROM afw_farmpiuw t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_farmpremiseinfo (farmpremiseinfo detail (name-derived, needs review), ~37 rows)
  "farmpremiseinfo": `
    SELECT t.polid, t.lobid, t.farmpiid, t.effdate, t.status, t.clocid, t.cbldgid, t.description, t.ishome, t.farmname, t.totacre, t.culacre, t.pasacre, t.farmby, t.grossrct, t.diagnum, t.isoccyr, t.isappmaint, t.repairdesc, t.iswateryr, t.watersrc, t.waterqty, t.addlcoverages, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.farmpiid, t.effdate, t.status, t.clocid, t.cbldgid, t.description, t.ishome, t.farmname, t.totacre, t.culacre, t.pasacre, t.farmby, t.grossrct, t.diagnum, t.isoccyr, t.isappmaint, t.repairdesc, t.iswateryr, t.watersrc, t.waterqty, t.addlcoverages, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.farmpiid ORDER BY t.effdate DESC) AS rn
      FROM afw_farmpremiseinfo t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_farmpropuw (farmpropuw detail (name-derived, needs review), ~1 rows)
  "farmpropuw": `
    SELECT t.polid, t.lobid, t.farmpuwid, t.effdate, t.status, t.ispropinsloc, t.farmseason, t.offseason, t.maxvalfarmin, t.maxvalfarmopen, t.maxvaloffin, t.maxvaloffopen, t.isequiploan, t.valueequip, t.radiusoper, t.isequipmaint, t.remark, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.farmpuwid, t.effdate, t.status, t.ispropinsloc, t.farmseason, t.offseason, t.maxvalfarmin, t.maxvalfarmopen, t.maxvaloffin, t.maxvaloffopen, t.isequiploan, t.valueequip, t.radiusoper, t.isequipmaint, t.remark, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.farmpuwid ORDER BY t.effdate DESC) AS rn
      FROM afw_farmpropuw t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_farmranch (farmranch detail (name-derived, needs review), ~9 rows)
  "farmranch": `
    SELECT t.polid, t.lobid, t.farmranchid, t.effdate, t.status, t.iscrops, t.isfruits, t.isvegetables, t.isdairy, t.ismushrooms, t.isnuts, t.isflowers, t.isvinyards, t.isgreenhouses, t.isnursery, t.issod, t.isworms, t.isbees, t.isfur, t.istobacco, t.ispoultry, t.livestock, t.other1, t.other2, t.lvstktype, t.other1desc, t.other2desc, t.operations, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.farmranchid, t.effdate, t.status, t.iscrops, t.isfruits, t.isvegetables, t.isdairy, t.ismushrooms, t.isnuts, t.isflowers, t.isvinyards, t.isgreenhouses, t.isnursery, t.issod, t.isworms, t.isbees, t.isfur, t.istobacco, t.ispoultry, t.livestock, t.other1, t.other2, t.lvstktype, t.other1desc, t.other2desc, t.operations, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.farmranchid ORDER BY t.effdate DESC) AS rn
      FROM afw_farmranch t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_farmsubofins (farmsubofins detail (name-derived, needs review), ~0 rows)
  "farmsubofins": `
    SELECT t.polid, t.lobid, t.farmsoiid, t.effdate, t.status, t.subject, t.peakfrom, t.peakto, t.haystk, t.haystkmax, t.notexceed, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.farmsoiid, t.effdate, t.status, t.subject, t.peakfrom, t.peakto, t.haystk, t.haystkmax, t.notexceed, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.farmsoiid ORDER BY t.effdate DESC) AS rn
      FROM afw_farmsubofins t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_farmuw (farmuw detail (name-derived, needs review), ~1 rows)
  "farmuw": `
    SELECT t.polid, t.lobid, t.farmuwid, t.effdate, t.status, t.inspdate, t.isopenrange, t.iscloserange, t.horse1, t.horse2, t.milkrct, t.numcows, t.ishuntown, t.ishuntrent, t.ishuntfee, t.huntrct, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.farmuwid, t.effdate, t.status, t.inspdate, t.isopenrange, t.iscloserange, t.horse1, t.horse2, t.milkrct, t.numcows, t.ishuntown, t.ishuntrent, t.ishuntfee, t.huntrct, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.farmuwid ORDER BY t.effdate DESC) AS rn
      FROM afw_farmuw t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_filing (filing detail (name-derived, needs review), ~0 rows)
  "filing": `
    SELECT t.polid, t.lobid, t.filid, t.drvid, t.effdate, t.status, t.filingdate, t.issuspended, t.reason, t.state, t.expirationdate, t.terminmonths, t.canceleddate, t.reindate, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.filid, t.drvid, t.effdate, t.status, t.filingdate, t.issuspended, t.reason, t.state, t.expirationdate, t.terminmonths, t.canceleddate, t.reindate, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.drvid, t.filid ORDER BY t.effdate DESC) AS rn
      FROM afw_filing t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_floodlocation (floodlocation detail (name-derived, needs review), ~51 rows)
  "floodlocation": `
    SELECT t.polid, t.lobid, t.locid, t.flocid, t.effdate, t.status, t.communityno, t.panelno, t.suffix, t.mapzone, t.programtype, t.isunincorporated, t.isspecialarea, t.infosourcecode, t.infosource, t.isfloodinsrequired, t.disasteragencycode, t.disasteragency, t.floodcaseno, t.waitingperiodcode, t.waitingperiod, t.questiona, t.questionb1, t.questionb2, t.questionb3, t.questionb4, t.questionb5, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.locid, t.flocid, t.effdate, t.status, t.communityno, t.panelno, t.suffix, t.mapzone, t.programtype, t.isunincorporated, t.isspecialarea, t.infosourcecode, t.infosource, t.isfloodinsrequired, t.disasteragencycode, t.disasteragency, t.floodcaseno, t.waitingperiodcode, t.waitingperiod, t.questiona, t.questionb1, t.questionb2, t.questionb3, t.questionb4, t.questionb5, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.locid, t.flocid ORDER BY t.effdate DESC) AS rn
      FROM afw_floodlocation t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_floodrating (floodrating detail (name-derived, needs review), ~0 rows) -- API-UNAVAILABLE: Data Lake API 404/500s on this table regardless of tenant (confirmed 2026-09-01), will stay empty regardless of grant status
  "floodrating": `
    SELECT t.polid, t.lobid, t.locid, t.flratid, t.effdate, t.status, t.occupancycode, t.occupancy, t.noofunits, t.basementcode, t.basement, t.noofloorscode, t.noofloors, t.occupancydesc, t.isbusinessrisk, t.isprimaryres, t.iscourseofconst, t.isownedbystate, t.replacecost, t.iscondocovforunit, t.condonoofunits, t.ishighrise, t.isbldgelevated, t.isbldgfreeofobstruction, t.contentlocationcode, t.contentlocation, t.iscontenthousehold, t.contentdesc, t.bldgpermitdate, t.mobileparkconstdate, t.constdate, t.mobileplacement, t.improvedate, t.isbldgpostfirmconst, t.bldgdiagramnum, t.lowestadjgrade, t.lowestfloorelev, t.basefloorelev, t.lowestbasefloordiff, t.basefloodwave, t.isbldgfloodproof, t.elevationcertdate, t.ratingtypecode, t.ratingtype, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.locid, t.flratid, t.effdate, t.status, t.occupancycode, t.occupancy, t.noofunits, t.basementcode, t.basement, t.noofloorscode, t.noofloors, t.occupancydesc, t.isbusinessrisk, t.isprimaryres, t.iscourseofconst, t.isownedbystate, t.replacecost, t.iscondocovforunit, t.condonoofunits, t.ishighrise, t.isbldgelevated, t.isbldgfreeofobstruction, t.contentlocationcode, t.contentlocation, t.iscontenthousehold, t.contentdesc, t.bldgpermitdate, t.mobileparkconstdate, t.constdate, t.mobileplacement, t.improvedate, t.isbldgpostfirmconst, t.bldgdiagramnum, t.lowestadjgrade, t.lowestfloorelev, t.basefloorelev, t.lowestbasefloordiff, t.basefloodwave, t.isbldgfloodproof, t.elevationcertdate, t.ratingtypecode, t.ratingtype, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.locid, t.flratid ORDER BY t.effdate DESC) AS rn
      FROM afw_floodrating t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_floodsectionone (floodsectionone detail (name-derived, needs review), ~43 rows)
  "floodsectionone": `
    SELECT t.polid, t.lobid, t.locid, t.flsoid, t.effdate, t.status, t.diagramno, t.lowestflrsqfeet, t.islowestflrabove, t.garageflrsqfeet, t.isgarageflrabove, t.equiplocationlevel, t.nearestshorecode, t.nearestshore, t.sourceoffloodingcode, t.sourceofflooding, t.isbasementbelowgrade, t.hasbasementequip, t.hasbaseequipmentfurnace, t.hasbaseequipmentwaterheater, t.hasbaseequipmentelevator, t.hasbaseequipmentheatpump, t.hasbaseequipmentfueltank, t.hasbaseequipmentwasherdryer, t.hasbaseequipmentairconditioner, t.hasbaseequipmentcistern, t.hasbaseequipmentfoodfreezer, t.hasbaseequipmentother, t.isgarageattached, t.garagetotalarea, t.hasgaragefloodopenings, t.garagenumofopenings, t.garagetotalareaopenings, t.isgarageuse, t.hasgarageequip, t.hasgarageequipmentfurnace, t.hasgarageequipmentwaterheater, t.hasgarageequipmentelevator, t.hasgarageequipmentheatpump, t.hasgarageequipmentfueltank, t.hasgarageequipmentwasherdryer, t.hasgarageequipmentairconditioner, t.hasgarageequipmentcistern, t.hasgarageequipmentfoodfreezer, t.hasgarageequipmentother, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.locid, t.flsoid, t.effdate, t.status, t.diagramno, t.lowestflrsqfeet, t.islowestflrabove, t.garageflrsqfeet, t.isgarageflrabove, t.equiplocationlevel, t.nearestshorecode, t.nearestshore, t.sourceoffloodingcode, t.sourceofflooding, t.isbasementbelowgrade, t.hasbasementequip, t.hasbaseequipmentfurnace, t.hasbaseequipmentwaterheater, t.hasbaseequipmentelevator, t.hasbaseequipmentheatpump, t.hasbaseequipmentfueltank, t.hasbaseequipmentwasherdryer, t.hasbaseequipmentairconditioner, t.hasbaseequipmentcistern, t.hasbaseequipmentfoodfreezer, t.hasbaseequipmentother, t.isgarageattached, t.garagetotalarea, t.hasgaragefloodopenings, t.garagenumofopenings, t.garagetotalareaopenings, t.isgarageuse, t.hasgarageequip, t.hasgarageequipmentfurnace, t.hasgarageequipmentwaterheater, t.hasgarageequipmentelevator, t.hasgarageequipmentheatpump, t.hasgarageequipmentfueltank, t.hasgarageequipmentwasherdryer, t.hasgarageequipmentairconditioner, t.hasgarageequipmentcistern, t.hasgarageequipmentfoodfreezer, t.hasgarageequipmentother, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.locid, t.flsoid ORDER BY t.effdate DESC) AS rn
      FROM afw_floodsectionone t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_floodsectiontwo (floodsectiontwo detail (name-derived, needs review), ~42 rows)
  "floodsectiontwo": `
    SELECT t.polid, t.lobid, t.locid, t.flstid, t.effdate, t.status, t.elevatedfoundationcode, t.elevatedfoundation, t.haselevatedequip, t.haselevatedequipmentfurnace, t.haselevatedequipmentwaterheater, t.haselevatedequipmentelevator, t.haselevatedequipmentheatpump, t.haselevatedequipmentfueltank, t.haselevatedequipmentwasherdryer, t.haselevatedequipmentairconditioner, t.haselevatedequipmentcistern, t.haselevatedequipmentfoodfreezer, t.haselevatedequipmentother, t.isenclosedfloor, t.enclosedfloortype, t.enclosedsize, t.iselevatedmaterial, t.elevatedmaterialtypecode, t.elevatedmaterialtype, t.isenclosedwithopening, t.enclosedopeningnum, t.enclosedopeningarea, t.enclosedforotherpurposecode, t.enclosedforotherpurposedesc, t.isenclosedwithareafinished, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.locid, t.flstid, t.effdate, t.status, t.elevatedfoundationcode, t.elevatedfoundation, t.haselevatedequip, t.haselevatedequipmentfurnace, t.haselevatedequipmentwaterheater, t.haselevatedequipmentelevator, t.haselevatedequipmentheatpump, t.haselevatedequipmentfueltank, t.haselevatedequipmentwasherdryer, t.haselevatedequipmentairconditioner, t.haselevatedequipmentcistern, t.haselevatedequipmentfoodfreezer, t.haselevatedequipmentother, t.isenclosedfloor, t.enclosedfloortype, t.enclosedsize, t.iselevatedmaterial, t.elevatedmaterialtypecode, t.elevatedmaterialtype, t.isenclosedwithopening, t.enclosedopeningnum, t.enclosedopeningarea, t.enclosedforotherpurposecode, t.enclosedforotherpurposedesc, t.isenclosedwithareafinished, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.locid, t.flstid ORDER BY t.effdate DESC) AS rn
      FROM afw_floodsectiontwo t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_floodtotal (floodtotal detail (name-derived, needs review), ~107 rows)
  "floodtotal": `
    SELECT t.polid, t.lobid, t.fltid, t.effdate, t.status, t.vbldglimit1, t.ibldglimit1, t.bldgprem, t.vcntlimit1, t.icntlimit1, t.cntprem, t.annualtotal, t.discsurchargestotal, t.addtlcovtotal, t.prepaidtotal, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.fltid, t.effdate, t.status, t.vbldglimit1, t.ibldglimit1, t.bldgprem, t.vcntlimit1, t.icntlimit1, t.cntprem, t.annualtotal, t.discsurchargestotal, t.addtlcovtotal, t.prepaidtotal, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.fltid ORDER BY t.effdate DESC) AS rn
      FROM afw_floodtotal t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_formtype (formtype detail (name-derived, needs review), ~4598 rows)
  "formtype": `
    SELECT t.polid, t.lobid, t.formid, t.locid, t.effdate, t.status, t.formtype, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.formid, t.locid, t.effdate, t.status, t.formtype, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.locid, t.formid ORDER BY t.effdate DESC) AS rn
      FROM afw_formtype t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_garage (Garage/dealer operations detail, ~11744 rows)
  "garage": `
    SELECT t.polid, t.lobid, t.garid, t.effdate, t.status, t.attachid, t.attachtype, t.garno, t.clocid, t.addr1, t.addr2, t.city, t.state, t.zip, t.description, t.taxcode, t.imlocid, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.garid, t.effdate, t.status, t.attachid, t.attachtype, t.garno, t.clocid, t.addr1, t.addr2, t.city, t.state, t.zip, t.description, t.taxcode, t.imlocid, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.garid ORDER BY t.effdate DESC) AS rn
      FROM afw_garage t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_healthcoverage (healthcoverage detail (name-derived, needs review), ~0 rows)
  "healthcoverage": `
    SELECT t.polid, t.lobid, t.hcovid, t.effdate, t.status, t.coveragecode, t.plan, t.premium, t.indoutpocketlimit, t.famoutpocketlimit, t.annualmax, t.lifetimemax, t.deduct, t.copay, t.coin, t.isdeductpct, t.iscopaypct, t.iscoinpct, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.hcovid, t.effdate, t.status, t.coveragecode, t.plan, t.premium, t.indoutpocketlimit, t.famoutpocketlimit, t.annualmax, t.lifetimemax, t.deduct, t.copay, t.coin, t.isdeductpct, t.iscopaypct, t.iscoinpct, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.hcovid ORDER BY t.effdate DESC) AS rn
      FROM afw_healthcoverage t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_healthmember (healthmember detail (name-derived, needs review), ~0 rows)
  "healthmember": `
    SELECT t.polid, t.lobid, t.hmemid, t.effdate, t.status, t.firstname, t.midname, t.lastname, t.class, t.comments, t.relation, t.occupation, t.marritalstatus, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.hmemid, t.effdate, t.status, t.firstname, t.midname, t.lastname, t.class, t.comments, t.relation, t.occupation, t.marritalstatus, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.hmemid ORDER BY t.effdate DESC) AS rn
      FROM afw_healthmember t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_healthprem (healthprem detail (name-derived, needs review), ~0 rows)
  "healthprem": `
    SELECT t.polid, t.lobid, t.hpremid, t.effdate, t.status, t.type, t.termpremium, t.annualpremium, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.hpremid, t.effdate, t.status, t.type, t.termpremium, t.annualpremium, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.hpremid ORDER BY t.effdate DESC) AS rn
      FROM afw_healthprem t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_hiredborrowed (hiredborrowed detail (name-derived, needs review), ~4003 rows)
  "hiredborrowed": `
    SELECT t.polid, t.lobid, t.state, t.hbid, t.effdate, t.status, t.class, t.hireamt, t.isifany, t.noofdays, t.noofveh, t.hireliabrate, t.hirepdrate, t.isminpremcharged, t.isprimary, t.applies, t.isonapp, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.state, t.hbid, t.effdate, t.status, t.class, t.hireamt, t.isifany, t.noofdays, t.noofveh, t.hireliabrate, t.hirepdrate, t.isminpremcharged, t.isprimary, t.applies, t.isonapp, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.hbid ORDER BY t.effdate DESC) AS rn
      FROM afw_hiredborrowed t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_homefeature (homefeature detail (name-derived, needs review), ~866 rows)
  "homefeature": `
    SELECT t.polid, t.lobid, t.hfeaid, t.locid, t.effdate, t.status, t.dwellfeature, t.featuretype, t.featurevalue, t.squarefeet, t.noofchimneys, t.noofhearths, t.noofbaths, t.noofcars, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.hfeaid, t.locid, t.effdate, t.status, t.dwellfeature, t.featuretype, t.featurevalue, t.squarefeet, t.noofchimneys, t.noofhearths, t.noofbaths, t.noofcars, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.locid, t.hfeaid ORDER BY t.effdate DESC) AS rn
      FROM afw_homefeature t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_homerating (homerating detail (name-derived, needs review), ~5345 rows)
  "homerating": `
    SELECT t.polid, t.lobid, t.hratid, t.locid, t.effdate, t.status, t.residencetype, t.constructiontype, t.dwellinguse, t.yearbuilt, t.totalsqft, t.marketvalue, t.replacecost, t.isoccupieddaily, t.isvistoneighbor, t.isdeadbolt, t.nooffamilies, t.noofrooms, t.weeksrented, t.noofapts, t.heattype, t.roofmaterial, t.purchasedate, t.dateinspected, t.occupancy, t.windclass, t.foundation, t.housekeeping, t.dwellloc, t.heattypesec, t.sprinkler, t.swimpool, t.issmokedetector, t.isfireextinguisher, t.divingboard, t.yearoccupied, t.nohouseres, t.purchaseprice, t.oilstorage, t.stormshuttertype, t.bldgcodegrade, t.taxcode, t.fire, t.temperature, t.smoke, t.burglar, t.locationfencehrat, t.protclass, t.isprotclassimp, t.territorycode, t.premiumgrp, t.hydrantdistance, t.firestadistance, t.noofunits, t.fireecrate, t.staterqmnts, t.dwellingloc, t.wiringupdate, t.wiringyear, t.plumbingupdate, t.plumbingyear, t.heatingupdate, t.heatingyear, t.roofingupdate, t.roofingyear, t.ratingmethod, t.firedistrict, t.firedistrictcode, t.nooffirediv, t.ecpremgrp, t.persliabterrcode, t.extpaint, t.condition, t.groundfloorsqft, t.noofstories, t.perimeterlinft, t.placecode, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.hratid, t.locid, t.effdate, t.status, t.residencetype, t.constructiontype, t.dwellinguse, t.yearbuilt, t.totalsqft, t.marketvalue, t.replacecost, t.isoccupieddaily, t.isvistoneighbor, t.isdeadbolt, t.nooffamilies, t.noofrooms, t.weeksrented, t.noofapts, t.heattype, t.roofmaterial, t.purchasedate, t.dateinspected, t.occupancy, t.windclass, t.foundation, t.housekeeping, t.dwellloc, t.heattypesec, t.sprinkler, t.swimpool, t.issmokedetector, t.isfireextinguisher, t.divingboard, t.yearoccupied, t.nohouseres, t.purchaseprice, t.oilstorage, t.stormshuttertype, t.bldgcodegrade, t.taxcode, t.fire, t.temperature, t.smoke, t.burglar, t.locationfencehrat, t.protclass, t.isprotclassimp, t.territorycode, t.premiumgrp, t.hydrantdistance, t.firestadistance, t.noofunits, t.fireecrate, t.staterqmnts, t.dwellingloc, t.wiringupdate, t.wiringyear, t.plumbingupdate, t.plumbingyear, t.heatingupdate, t.heatingyear, t.roofingupdate, t.roofingyear, t.ratingmethod, t.firedistrict, t.firedistrictcode, t.nooffirediv, t.ecpremgrp, t.persliabterrcode, t.extpaint, t.condition, t.groundfloorsqft, t.noofstories, t.perimeterlinft, t.placecode, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.locid, t.hratid ORDER BY t.effdate DESC) AS rn
      FROM afw_homerating t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_homereplacement (homereplacement detail (name-derived, needs review), ~5042 rows)
  "homereplacement": `
    SELECT t.polid, t.lobid, t.hrepid, t.locid, t.effdate, t.status, t.replacecost, t.evalsystem, t.basecost, t.adjustment, t.totalfeatures, t.totalbasecost, t.locationmultiplier, t.depreciationamt, t.actualcostvalue, t.notes, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.hrepid, t.locid, t.effdate, t.status, t.replacecost, t.evalsystem, t.basecost, t.adjustment, t.totalfeatures, t.totalbasecost, t.locationmultiplier, t.depreciationamt, t.actualcostvalue, t.notes, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.locid, t.hrepid ORDER BY t.effdate DESC) AS rn
      FROM afw_homereplacement t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_horse (horse detail (name-derived, needs review), ~0 rows)
  "horse": `
    SELECT t.horseid, t.polid, t.lobid, t.status, t.effdate, t.horseno, t.horsename, t.breed, t.purchasedate, t.purchaseprice, t.dateofbirth, t.age, t.sex, t.use, t.originallimit, t.plugbinder, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.horseid, t.polid, t.lobid, t.status, t.effdate, t.horseno, t.horsename, t.breed, t.purchasedate, t.purchaseprice, t.dateofbirth, t.age, t.sex, t.use, t.originallimit, t.plugbinder, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.horseid ORDER BY t.effdate DESC) AS rn
      FROM afw_horse t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_horseplanlob (horseplanlob detail (name-derived, needs review), ~0 rows)
  "horseplanlob": `
    SELECT t.horseplanlobid, t.polid, t.lobid, t.effdate, t.planid, t.status, t.statetaxrate, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.horseplanlobid, t.polid, t.lobid, t.effdate, t.planid, t.status, t.statetaxrate, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.horseplanlobid ORDER BY t.effdate DESC) AS rn
      FROM afw_horseplanlob t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_lifebeneficiary (lifebeneficiary detail (name-derived, needs review), ~0 rows)
  "lifebeneficiary": `
    SELECT t.polid, t.lobid, t.lbenid, t.effdate, t.status, t.firstnamelben, t.midnamelben, t.lastnamelben, t.relinsuredlben, t.isprimarylben, t.percentlben, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.lbenid, t.effdate, t.status, t.firstnamelben, t.midnamelben, t.lastnamelben, t.relinsuredlben, t.isprimarylben, t.percentlben, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.lbenid ORDER BY t.effdate DESC) AS rn
      FROM afw_lifebeneficiary t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_lifecoverage (lifecoverage detail (name-derived, needs review), ~11 rows)
  "lifecoverage": `
    SELECT t.polid, t.lobid, t.lcovid, t.effdate, t.status, t.typelcov, t.planlcov, t.noofyearslcov, t.isconvertiblelcov, t.convdatelcov, t.facevaluelcov, t.termpremiumlcov, t.annualpremiumlcov, t.addlratinglcov, t.isgiooptionlcov, t.isadboptionlcov, t.iswpoptionlcov, t.isdivplanoptionlcov, t.isspouseriderlcov, t.spouseunitslcov, t.ischildriderlcov, t.childunitslcov, t.isotheroptionlcov, t.otherdescrlcov, t.issmokerlcov, t.isincreasinglcov, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.lcovid, t.effdate, t.status, t.typelcov, t.planlcov, t.noofyearslcov, t.isconvertiblelcov, t.convdatelcov, t.facevaluelcov, t.termpremiumlcov, t.annualpremiumlcov, t.addlratinglcov, t.isgiooptionlcov, t.isadboptionlcov, t.iswpoptionlcov, t.isdivplanoptionlcov, t.isspouseriderlcov, t.spouseunitslcov, t.ischildriderlcov, t.childunitslcov, t.isotheroptionlcov, t.otherdescrlcov, t.issmokerlcov, t.isincreasinglcov, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.lcovid ORDER BY t.effdate DESC) AS rn
      FROM afw_lifecoverage t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_lifeotherinsurance (lifeotherinsurance detail (name-derived, needs review), ~0 rows)
  "lifeotherinsurance": `
    SELECT t.polid, t.lobid, t.loiid, t.effdate, t.status, t.cocode, t.yearissuedloi, t.amountloi, t.adbbenefitloi, t.iswaiverloi, t.isreplacedbyloi, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.loiid, t.effdate, t.status, t.cocode, t.yearissuedloi, t.amountloi, t.adbbenefitloi, t.iswaiverloi, t.isreplacedbyloi, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.loiid ORDER BY t.effdate DESC) AS rn
      FROM afw_lifeotherinsurance t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_lifeowner (lifeowner detail (name-derived, needs review), ~6 rows)
  "lifeowner": `
    SELECT t.polid, t.lobid, t.lownid, t.effdate, t.status, t.namelown, t.address1lown, t.address2lown, t.citylown, t.statelown, t.ziplown, t.reltoinsuredlown, t.entitylown, t.ispayorlown, t.phoneareacodelown, t.phonelown, t.phoneextlown, t.faxareacodelown, t.faxphonelown, t.faxextlown, t.emaillown, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.lownid, t.effdate, t.status, t.namelown, t.address1lown, t.address2lown, t.citylown, t.statelown, t.ziplown, t.reltoinsuredlown, t.entitylown, t.ispayorlown, t.phoneareacodelown, t.phonelown, t.phoneextlown, t.faxareacodelown, t.faxphonelown, t.faxextlown, t.emaillown, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.lownid ORDER BY t.effdate DESC) AS rn
      FROM afw_lifeowner t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_location (location detail (name-derived, needs review), ~9356 rows)
  "location": `
    SELECT t.polid, t.lobid, t.locid, t.effdate, t.status, t.locno, t.addrsameasapp, t.addr1, t.addr2, t.city, t.county, t.state, t.zipcode, t.legaldesc, t.yearbuilt, t.interest, t.residencetype, t.occupancy, t.noofunits, t.usage, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.locid, t.effdate, t.status, t.locno, t.addrsameasapp, t.addr1, t.addr2, t.city, t.county, t.state, t.zipcode, t.legaldesc, t.yearbuilt, t.interest, t.residencetype, t.occupancy, t.noofunits, t.usage, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.locid ORDER BY t.effdate DESC) AS rn
      FROM afw_location t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_losshistory (losshistory detail (name-derived, needs review), ~4112 rows)
  "losshistory": `
    SELECT t.polid, t.lobid, t.losshistid, t.effdate, t.status, t.company, t.lineofbus, t.dateofloss, t.lossdatenote, t.polno, t.poleffdate, t.polexpdate, t.kindofloss, t.lossdesc, t.amountpaid, t.amtreserved, t.claimstatus, t.reportdate, t.noofclaimslhis, t.annualpremlhis, t.modlhis, t.naiclhis, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.losshistid, t.effdate, t.status, t.company, t.lineofbus, t.dateofloss, t.lossdatenote, t.polno, t.poleffdate, t.polexpdate, t.kindofloss, t.lossdesc, t.amountpaid, t.amtreserved, t.claimstatus, t.reportdate, t.noofclaimslhis, t.annualpremlhis, t.modlhis, t.naiclhis, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.losshistid ORDER BY t.effdate DESC) AS rn
      FROM afw_losshistory t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_mobilehome (mobilehome detail (name-derived, needs review), ~5 rows)
  "mobilehome": `
    SELECT t.polid, t.lobid, t.mobhid, t.locid, t.effdate, t.status, t.yearbuilt, t.make, t.model, t.idno, t.length, t.width, t.parkname, t.purchasedate, t.costnew, t.isnew, t.cooklocation, t.tiedowntypecode, t.tiedowntype, t.hasaddition, t.additionlength, t.additionwidth, t.installationcode, t.installation, t.isparksubdivision, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.mobhid, t.locid, t.effdate, t.status, t.yearbuilt, t.make, t.model, t.idno, t.length, t.width, t.parkname, t.purchasedate, t.costnew, t.isnew, t.cooklocation, t.tiedowntypecode, t.tiedowntype, t.hasaddition, t.additionlength, t.additionwidth, t.installationcode, t.installation, t.isparksubdivision, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.locid, t.mobhid ORDER BY t.effdate DESC) AS rn
      FROM afw_mobilehome t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_name (name detail (name-derived, needs review), ~0 rows)
  "name": `
    SELECT t.polid, t.lobid, t.namid, t.coptid, t.effdate, t.status, t.name, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.namid, t.coptid, t.effdate, t.status, t.name, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.coptid, t.namid ORDER BY t.effdate DESC) AS rn
      FROM afw_name t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_nonowned (nonowned detail (name-derived, needs review), ~2043 rows)
  "nonowned": `
    SELECT t.polid, t.lobid, t.state, t.noid, t.effdate, t.status, t.class, t.grouptype, t.numberof, t.pct, t.isssagency, t.isliabcovemppur, t.applies, t.isonapp, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.state, t.noid, t.effdate, t.status, t.class, t.grouptype, t.numberof, t.pct, t.isssagency, t.isliabcovemppur, t.applies, t.isonapp, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.noid ORDER BY t.effdate DESC) AS rn
      FROM afw_nonowned t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_personalumbrella (personalumbrella detail (name-derived, needs review), ~0 rows)
  "personalumbrella": `
    SELECT t.polid, t.lobid, t.pumbid, t.effdate, t.status, t.lineofbus, t.polno, t.company, t.coverage, t.limit1, t.limit2, t.limit3, t.poleffdate, t.polexpdate, t.anypolexclusions, t.anypolcancels, t.territory, t.retentionamt, t.insertseqno, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.pumbid, t.effdate, t.status, t.lineofbus, t.polno, t.company, t.coverage, t.limit1, t.limit2, t.limit3, t.poleffdate, t.polexpdate, t.anypolexclusions, t.anypolcancels, t.territory, t.retentionamt, t.insertseqno, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.pumbid ORDER BY t.effdate DESC) AS rn
      FROM afw_personalumbrella t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_persumbrellarating (persumbrellarating detail (name-derived, needs review), ~0 rows)
  "persumbrellarating": `
    SELECT t.polid, t.lobid, t.pumrid, t.effdate, t.status, t.noofautos, t.noofinexpdrivers, t.noofrecvehicles, t.noofyouthdrivers, t.noofresidences, t.noofdwellings, t.noofoffices, t.noofwatercraft, t.nooffarms, t.territory, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.pumrid, t.effdate, t.status, t.noofautos, t.noofinexpdrivers, t.noofrecvehicles, t.noofyouthdrivers, t.noofresidences, t.noofdwellings, t.noofoffices, t.noofwatercraft, t.nooffarms, t.territory, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.pumrid ORDER BY t.effdate DESC) AS rn
      FROM afw_persumbrellarating t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_physician (physician detail (name-derived, needs review), ~0 rows)
  "physician": `
    SELECT t.polid, t.lobid, t.phyid, t.effdate, t.status, t.namephy, t.address1phy, t.address2phy, t.cityphy, t.statephy, t.zipphy, t.lastconsultedphy, t.reasonphy, t.physicianforphy, t.phoneareacodephy, t.phonephy, t.phoneextphy, t.faxareacodephy, t.faxphonephy, t.faxextphy, t.emailphy, t.isprimarycare, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.phyid, t.effdate, t.status, t.namephy, t.address1phy, t.address2phy, t.cityphy, t.statephy, t.zipphy, t.lastconsultedphy, t.reasonphy, t.physicianforphy, t.phoneareacodephy, t.phonephy, t.phoneextphy, t.faxareacodephy, t.faxphonephy, t.faxextphy, t.emailphy, t.isprimarycare, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.phyid ORDER BY t.effdate DESC) AS rn
      FROM afw_physician t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_polcontactphonemap (polcontactphonemap detail (name-derived, needs review), ~154 rows)
  "polcontactphonemap": `
    SELECT t.attachid, t.polid, t.lobid, t.polcid, t.effdate
    FROM (
      SELECT t.attachid, t.polid, t.lobid, t.polcid, t.effdate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.attachid ORDER BY t.effdate DESC) AS rn
      FROM afw_polcontactphonemap t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1
    ORDER BY t.polid, t.lobid
  `,

  // afw_policyattributehistory (policyattributehistory detail (name-derived, needs review), ~0 rows) -- NO DEDUP: no effdate + own-PK combo found, plain select, confirmed 1:1/non-historized for some of these (peer review 2026-09-01), verify the rest before assuming -- API-UNAVAILABLE: Data Lake API 404/500s on this table regardless of tenant (confirmed 2026-09-01), will stay empty regardless of grant status
  "policyattributehistory": `
    SELECT t.policyattributehistoryid, t.policyattributeid, t.polid, t.policyattributetypeid, t.policyattributevalue, t.sqlaction, t.loggedby, t.loggeddate, t.changedby, t.changeddate, t.enteredby, t.entereddate
    FROM afw_policyattributehistory t
    WHERE t.polid = ANY($1::uuid[])
    ORDER BY t.polid
  `,

  // afw_policychklstheader (policychklstheader detail (name-derived, needs review), ~0 rows)
  "policychklstheader": `
    SELECT t.polid, t.polchid, t.effdate, t.checklistname, t.empcode, t.iscomplete, t.dateinitiated, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.polchid, t.effdate, t.checklistname, t.empcode, t.iscomplete, t.dateinitiated, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.polchid ORDER BY t.effdate DESC) AS rn
      FROM afw_policychklstheader t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1
    ORDER BY t.polid
  `,

  // afw_policypersonnelperiods (policypersonnelperiods detail (name-derived, needs review), ~47227 rows) -- NO DEDUP: no effdate + own-PK combo found, plain select, confirmed 1:1/non-historized for some of these (peer review 2026-09-01), verify the rest before assuming
  "policypersonnelperiods": `
    SELECT t.polid, t.empcode, t.emptype, t.isactive, t.startdate, t.enddate, t.issuspended, t.changedby, t.changeddate, t.entereddate
    FROM afw_policypersonnelperiods t
    WHERE t.polid = ANY($1::uuid[])
    ORDER BY t.polid
  `,

  // afw_policysubcustomer (policysubcustomer detail (name-derived, needs review), ~0 rows)
  "policysubcustomer": `
    SELECT t.polid, t.polscid, t.effdate, t.status, t.custid, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.polscid, t.effdate, t.status, t.custid, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.custid, t.polscid ORDER BY t.effdate DESC) AS rn
      FROM afw_policysubcustomer t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid
  `,

  // afw_policytranpremium (policytranpremium detail (name-derived, needs review), ~47178 rows)
  "policytranpremium": `
    SELECT t.polid, t.poltpid, t.effdate, t.lineofbus, t.plantype, t.writingcocode, t.premium, t.billedpremium, t.writtenpremium, t.fulltermpremium, t.howbilled, t.includepremium, t.iscorrected, t.isposted, t.issuspended, t.chargecatpoltp, t.chargecodepoltp, t.nonprrecipientpoltp, t.nonprinsttreatpoltp, t.cocodepoltp, t.cotypepoltp, t.descriptionpoltp, t.insertseqno, t.reconciled, t.ticomid, t.estrevenue, t.changedby, t.changeddate, t.entereddate, t.percentofrisk, t.annualizedpremium, t.annualizedestrevenue
    FROM (
      SELECT t.polid, t.poltpid, t.effdate, t.lineofbus, t.plantype, t.writingcocode, t.premium, t.billedpremium, t.writtenpremium, t.fulltermpremium, t.howbilled, t.includepremium, t.iscorrected, t.isposted, t.issuspended, t.chargecatpoltp, t.chargecodepoltp, t.nonprrecipientpoltp, t.nonprinsttreatpoltp, t.cocodepoltp, t.cotypepoltp, t.descriptionpoltp, t.insertseqno, t.reconciled, t.ticomid, t.estrevenue, t.changedby, t.changeddate, t.entereddate, t.percentofrisk, t.annualizedpremium, t.annualizedestrevenue,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.poltpid ORDER BY t.effdate DESC) AS rn
      FROM afw_policytranpremium t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1
    ORDER BY t.polid
  `,

  // afw_polumbrella (polumbrella detail (name-derived, needs review), ~5416 rows)
  "polumbrella": `
    SELECT t.polid, t.lobid, t.poluid, t.effdate, t.status, t.undpolid, t.undpolno, t.company, t.lob, t.undeffdate, t.undexpdate, t.exclusions, t.cancellations, t.formsection, t.plantype, t.naic, t.bipercsl, t.biacc, t.pd, t.unbipercsl, t.unbiacc, t.unpd, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.poluid, t.effdate, t.status, t.undpolid, t.undpolno, t.company, t.lob, t.undeffdate, t.undexpdate, t.exclusions, t.cancellations, t.formsection, t.plantype, t.naic, t.bipercsl, t.biacc, t.pd, t.unbipercsl, t.unbiacc, t.unpd, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.poluid ORDER BY t.effdate DESC) AS rn
      FROM afw_polumbrella t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_pproducer (Producer info on the policy, ~16650 rows)
  "pproducer": `
    SELECT t.polid, t.pprodid, t.effdate, t.status, t.mailpolicyto, t.mailotherdesc, t.sigempcode, t.authempcode, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.pprodid, t.effdate, t.status, t.mailpolicyto, t.mailotherdesc, t.sigempcode, t.authempcode, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.pprodid ORDER BY t.effdate DESC) AS rn
      FROM afw_pproducer t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid
  `,

  // afw_prevaddr (prevaddr detail (name-derived, needs review), ~8270 rows)
  "prevaddr": `
    SELECT t.polid, t.preid, t.effdate, t.status, t.addr1, t.addr2, t.city, t.state, t.zip, t.addrsince, t.iscrntowned, t.iscrntrented, t.yrprevaddr, t.vehinhouse, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.preid, t.effdate, t.status, t.addr1, t.addr2, t.city, t.state, t.zip, t.addrsince, t.iscrntowned, t.iscrntrented, t.yrprevaddr, t.vehinhouse, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.preid ORDER BY t.effdate DESC) AS rn
      FROM afw_prevaddr t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid
  `,

  // afw_priorcarrier (priorcarrier detail (name-derived, needs review), ~8926 rows)
  "priorcarrier": `
    SELECT t.polid, t.lobid, t.pcarid, t.effdate, t.status, t.naiccompcode, t.priorcarrier, t.policyno, t.polexpdate, t.poleffdate, t.lineofbus, t.plantype, t.premium, t.vpremium, t.limit1, t.limit2, t.limit3, t.limit4, t.limit5, t.limit6, t.limit7, t.limit8, t.limit9, t.limit10, t.limit11, t.vlimit1, t.vlimit2, t.vlimit3, t.vlimit4, t.vlimit5, t.vlimit6, t.vlimit7, t.vlimit8, t.vlimit9, t.vlimit10, t.vlimit11, t.modfactor, t.isoccurrence, t.policytype, t.retrodate, t.convertretrodate, t.other, t.withcosince, t.producer, t.yearno, t.convertpoleffexp, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.pcarid, t.effdate, t.status, t.naiccompcode, t.priorcarrier, t.policyno, t.polexpdate, t.poleffdate, t.lineofbus, t.plantype, t.premium, t.vpremium, t.limit1, t.limit2, t.limit3, t.limit4, t.limit5, t.limit6, t.limit7, t.limit8, t.limit9, t.limit10, t.limit11, t.vlimit1, t.vlimit2, t.vlimit3, t.vlimit4, t.vlimit5, t.vlimit6, t.vlimit7, t.vlimit8, t.vlimit9, t.vlimit10, t.vlimit11, t.modfactor, t.isoccurrence, t.policytype, t.retrodate, t.convertretrodate, t.other, t.withcosince, t.producer, t.yearno, t.convertpoleffexp, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.pcarid ORDER BY t.effdate DESC) AS rn
      FROM afw_priorcarrier t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_queidquestionanswers (queidquestionanswers detail (name-derived, needs review), ~0 rows) -- API-UNAVAILABLE: Data Lake API 404/500s on this table regardless of tenant (confirmed 2026-09-01), will stay empty regardless of grant status
  "queidquestionanswers": `
    SELECT t.queidquestionanswersid, t.answersetid, t.queid, t.polid, t.lobid, t.effdate, t.status, t.attachtype, t.attachid, t.answer, t.additionalremarksxml, t.changedby, t.changeddate, t.enteredby, t.entereddate, t.queidanswersid
    FROM (
      SELECT t.queidquestionanswersid, t.answersetid, t.queid, t.polid, t.lobid, t.effdate, t.status, t.attachtype, t.attachid, t.answer, t.additionalremarksxml, t.changedby, t.changeddate, t.enteredby, t.entereddate, t.queidanswersid,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.queidquestionanswersid ORDER BY t.effdate DESC) AS rn
      FROM afw_queidquestionanswers t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_ratedate (ratedate detail (name-derived, needs review), ~2694 rows)
  "ratedate": `
    SELECT t.polid, t.rdateid, t.effdate, t.status, t.lineofbus, t.state, t.ratedate, t.insertseqno, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.rdateid, t.effdate, t.status, t.lineofbus, t.state, t.ratedate, t.insertseqno, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.rdateid ORDER BY t.effdate DESC) AS rn
      FROM afw_ratedate t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid
  `,

  // afw_record (record detail (name-derived, needs review), ~4437 rows)
  "record": `
    SELECT t.polid, t.lobid, t.drvid, t.recid, t.effdate, t.status, t.violation, t.occurdate, t.convictdate, t.isbideath, t.description, t.accidentplace, t.bipaid, t.pdpaid, t.medpay, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.drvid, t.recid, t.effdate, t.status, t.violation, t.occurdate, t.convictdate, t.isbideath, t.description, t.accidentplace, t.bipaid, t.pdpaid, t.medpay, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.drvid, t.recid ORDER BY t.effdate DESC) AS rn
      FROM afw_record t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_remark (Free-text remarks throughout the policy, ~35610 rows)
  "remark": `
    SELECT t.polid, t.lobid, t.remarkid, t.effdate, t.status, t.attachid, t.attachtype, t.remark, t.issaved, t.isuploaded, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.remarkid, t.effdate, t.status, t.attachid, t.attachtype, t.remark, t.issaved, t.isuploaded, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.remarkid ORDER BY t.effdate DESC) AS rn
      FROM afw_remark t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_serviceagreement (serviceagreement detail (name-derived, needs review), ~0 rows) -- NO DEDUP: no effdate + own-PK combo found, plain select, confirmed 1:1/non-historized for some of these (peer review 2026-09-01), verify the rest before assuming
  "serviceagreement": `
    SELECT t.said, t.satype, t.custid, t.polid, t.description, t.auditdate, t.auditcloseddate, t.auditstatusid, t.issignedagreementreceived, t.agreementamount, t.changedby, t.changeddate, t.entereddate, t.isnewserviceagreement
    FROM afw_serviceagreement t
    WHERE t.polid = ANY($1::uuid[])
    ORDER BY t.polid
  `,

  // afw_serviceagreementpolicies (serviceagreementpolicies detail (name-derived, needs review), ~0 rows) -- NO DEDUP: no effdate + own-PK combo found, plain select, confirmed 1:1/non-historized for some of these (peer review 2026-09-01), verify the rest before assuming
  "serviceagreementpolicies": `
    SELECT t.said, t.polid, t.changedby, t.changeddate, t.entereddate
    FROM afw_serviceagreementpolicies t
    WHERE t.polid = ANY($1::uuid[])
    ORDER BY t.polid
  `,

  // afw_snowmobile (snowmobile detail (name-derived, needs review), ~0 rows)
  "snowmobile": `
    SELECT t.polid, t.lobid, t.snowid, t.effdate, t.status, t.vehicleno, t.covehicleno, t.serialno, t.manufacturer, t.make, t.model, t.displacement, t.horsepower, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.snowid, t.effdate, t.status, t.vehicleno, t.covehicleno, t.serialno, t.manufacturer, t.make, t.model, t.displacement, t.horsepower, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.snowid ORDER BY t.effdate DESC) AS rn
      FROM afw_snowmobile t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_specbuilding (specbuilding detail (name-derived, needs review), ~0 rows)
  "specbuilding": `
    SELECT t.polid, t.lobid, t.slocid, t.sbldgid, t.effdate, t.status, t.bldgno, t.description, t.citylimits, t.interest, t.yearbuilt, t.partoccupied, t.sameasloc, t.addr1, t.addr2, t.city, t.county, t.state, t.zip, t.clocid, t.cbldgid, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.slocid, t.sbldgid, t.effdate, t.status, t.bldgno, t.description, t.citylimits, t.interest, t.yearbuilt, t.partoccupied, t.sameasloc, t.addr1, t.addr2, t.city, t.county, t.state, t.zip, t.clocid, t.cbldgid, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.slocid, t.sbldgid ORDER BY t.effdate DESC) AS rn
      FROM afw_specbuilding t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_speclocation (speclocation detail (name-derived, needs review), ~0 rows)
  "speclocation": `
    SELECT t.polid, t.lobid, t.slocid, t.effdate, t.status, t.clocid, t.locno, t.addrsameasapp, t.addr1, t.addr2, t.city, t.county, t.state, t.zip, t.legaldesc, t.yearbuilt, t.interest, t.partoccupied, t.citylimits, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.slocid, t.effdate, t.status, t.clocid, t.locno, t.addrsameasapp, t.addr1, t.addr2, t.city, t.county, t.state, t.zip, t.legaldesc, t.yearbuilt, t.interest, t.partoccupied, t.citylimits, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.slocid ORDER BY t.effdate DESC) AS rn
      FROM afw_speclocation t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_specratinganswer (specratinganswer detail (name-derived, needs review), ~0 rows)
  "specratinganswer": `
    SELECT t.polid, t.lobid, t.sratid, t.effdate, t.status, t.attachid, t.attachtype, t.uifldid, t.answer, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.sratid, t.effdate, t.status, t.attachid, t.attachtype, t.uifldid, t.answer, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.sratid ORDER BY t.effdate DESC) AS rn
      FROM afw_specratinganswer t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_specrisk (specrisk detail (name-derived, needs review), ~0 rows)
  "specrisk": `
    SELECT t.polid, t.lobid, t.srid, t.effdate, t.status, t.riskno, t.descriptionsr, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.srid, t.effdate, t.status, t.riskno, t.descriptionsr, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.srid ORDER BY t.effdate DESC) AS rn
      FROM afw_specrisk t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_specriskanswer (specriskanswer detail (name-derived, needs review), ~0 rows)
  "specriskanswer": `
    SELECT t.polid, t.lobid, t.srid, t.sriskid, t.effdate, t.status, t.uifldid, t.answer, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.srid, t.sriskid, t.effdate, t.status, t.uifldid, t.answer, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.srid, t.sriskid ORDER BY t.effdate DESC) AS rn
      FROM afw_specriskanswer t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_specunderwritinganswer (specunderwritinganswer detail (name-derived, needs review), ~0 rows)
  "specunderwritinganswer": `
    SELECT t.polid, t.lobid, t.suwid, t.effdate, t.status, t.uifldid, t.answer, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.suwid, t.effdate, t.status, t.uifldid, t.answer, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.suwid ORDER BY t.effdate DESC) AS rn
      FROM afw_specunderwritinganswer t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_sppaddinfo (sppaddinfo detail (name-derived, needs review), ~21 rows)
  "sppaddinfo": `
    SELECT t.polid, t.lobid, t.spaddid, t.effdate, t.status, t.additionallocation, t.nooffamilies, t.protclass, t.territorycode, t.firedistrict, t.firedistrictcode, t.residencetype, t.constructiontype, t.other, t.addratinginfospadd, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.spaddid, t.effdate, t.status, t.additionallocation, t.nooffamilies, t.protclass, t.territorycode, t.firedistrict, t.firedistrictcode, t.residencetype, t.constructiontype, t.other, t.addratinginfospadd, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.spaddid ORDER BY t.effdate DESC) AS rn
      FROM afw_sppaddinfo t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_sppitem (Personal articles/scheduled personal property (PIM/Homeowner) items, ~11852 rows)
  "sppitem": `
    SELECT t.polid, t.lobid, t.spitmid, t.spsumid, t.effdate, t.status, t.itemnumber, t.serialnumber, t.description, t.valuationdate, t.value, t.appraisal, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.spitmid, t.spsumid, t.effdate, t.status, t.itemnumber, t.serialnumber, t.description, t.valuationdate, t.value, t.appraisal, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.spsumid, t.spitmid ORDER BY t.effdate DESC) AS rn
      FROM afw_sppitem t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_sppsummary (sppsummary detail (name-derived, needs review), ~3316 rows)
  "sppsummary": `
    SELECT t.polid, t.lobid, t.spsumid, t.effdate, t.status, t.class, t.spplimit, t.deductible, t.deductibletype, t.rate, t.premium, t.settlement, t.classcondition1, t.classcondition2, t.classcondition3, t.isprofcommercial, t.isexhibited, t.totalitems, t.totalvalue, t.formnumber, t.editiondate, t.clocid, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.spsumid, t.effdate, t.status, t.class, t.spplimit, t.deductible, t.deductibletype, t.rate, t.premium, t.settlement, t.classcondition1, t.classcondition2, t.classcondition3, t.isprofcommercial, t.isexhibited, t.totalitems, t.totalvalue, t.formnumber, t.editiondate, t.clocid, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.spsumid ORDER BY t.effdate DESC) AS rn
      FROM afw_sppsummary t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_submit (submit detail (name-derived, needs review), ~0 rows) -- NO DEDUP: no effdate + own-PK combo found, plain select, confirmed 1:1/non-historized for some of these (peer review 2026-09-01), verify the rest before assuming -- API-UNAVAILABLE: Data Lake API 404/500s on this table regardless of tenant (confirmed 2026-09-01), will stay empty regardless of grant status
  "submit": `
    SELECT t.polid, t.effdate, t.status, t.quoteorissue, t.isbound, t.bounddate, t.downpercent, t.changedby, t.changeddate, t.entereddate
    FROM afw_submit t
    WHERE t.polid = ANY($1::uuid[]) AND t.status != 'D'
    ORDER BY t.polid
  `,

  // afw_umbrellaprem (umbrellaprem detail (name-derived, needs review), ~2158 rows)
  "umbrellaprem": `
    SELECT t.polid, t.lobid, t.upremid, t.effdate, t.status, t.territory, t.isumbrella, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.upremid, t.effdate, t.status, t.territory, t.isumbrella, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.upremid ORDER BY t.effdate DESC) AS rn
      FROM afw_umbrellaprem t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_underwriting (underwriting detail (name-derived, needs review), ~2503 rows)
  "underwriting": `
    SELECT t.polid, t.lobid, t.uwid, t.attachid, t.attachtype, t.effdate, t.status, t.answer1, t.answer2, t.answer3, t.answer4, t.answer5, t.answer6, t.answer7, t.answer8, t.answer9, t.answer10, t.answer11, t.answer12, t.answer13, t.answer14, t.answer15, t.answer16, t.answer17, t.answer18, t.answer19, t.answer20, t.answer21, t.answer22, t.answer23, t.answer24, t.answer25, t.answer26, t.answer27, t.answer28, t.answer29, t.answer30, t.answer31, t.answer32, t.answer33, t.answer34, t.answer35, t.answer36, t.answer37, t.grossreceipts, t.tidalwaterdistvalue, t.tidalwaterdisttype, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.uwid, t.attachid, t.attachtype, t.effdate, t.status, t.answer1, t.answer2, t.answer3, t.answer4, t.answer5, t.answer6, t.answer7, t.answer8, t.answer9, t.answer10, t.answer11, t.answer12, t.answer13, t.answer14, t.answer15, t.answer16, t.answer17, t.answer18, t.answer19, t.answer20, t.answer21, t.answer22, t.answer23, t.answer24, t.answer25, t.answer26, t.answer27, t.answer28, t.answer29, t.answer30, t.answer31, t.answer32, t.answer33, t.answer34, t.answer35, t.answer36, t.answer37, t.grossreceipts, t.tidalwaterdistvalue, t.tidalwaterdisttype, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.uwid ORDER BY t.effdate DESC) AS rn
      FROM afw_underwriting t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_unsupporteddata (unsupporteddata detail (name-derived, needs review), ~0 rows) -- API-UNAVAILABLE: Data Lake API 404/500s on this table regardless of tenant (confirmed 2026-09-01), will stay empty regardless of grant status
  "unsupporteddata": `
    SELECT t.polid, t.lobid, t.udid, t.effdate, t.status, t.attachid, t.attachtype, t.groupid, t.isroot, t.datavalue, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.udid, t.effdate, t.status, t.attachid, t.attachtype, t.groupid, t.isroot, t.datavalue, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.udid ORDER BY t.effdate DESC) AS rn
      FROM afw_unsupporteddata t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_usage (usage detail (name-derived, needs review), ~5055 rows)
  "usage": `
    SELECT t.polid, t.useid, t.lobid, t.drvid, t.attachid, t.attachtype, t.effdate, t.status, t.usepct, t.other, t.isgovdriver, t.isvehmostused, t.isowner, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.useid, t.lobid, t.drvid, t.attachid, t.attachtype, t.effdate, t.status, t.usepct, t.other, t.isgovdriver, t.isvehmostused, t.isowner, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.useid ORDER BY t.effdate DESC) AS rn
      FROM afw_usage t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

  // afw_watercraft (watercraft detail (name-derived, needs review), ~361 rows)
  "watercraft": `
    SELECT t.polid, t.lobid, t.watrid, t.effdate, t.status, t.unitno, t.unittype, t.modelyear, t.horsepower, t.length, t.speed, t.propulsiontype, t.unitdescription, t.motordescription, t.navigationbegin, t.navigationend, t.watersnavigated, t.noofoperators, t.waterskiing, t.costnew, t.currentvalue, t.purchasedate, t.berthaddr1, t.berthaddr2, t.berthcity, t.berthstate, t.berthzip, t.changedby, t.changeddate, t.entereddate
    FROM (
      SELECT t.polid, t.lobid, t.watrid, t.effdate, t.status, t.unitno, t.unittype, t.modelyear, t.horsepower, t.length, t.speed, t.propulsiontype, t.unitdescription, t.motordescription, t.navigationbegin, t.navigationend, t.watersnavigated, t.noofoperators, t.waterskiing, t.costnew, t.currentvalue, t.purchasedate, t.berthaddr1, t.berthaddr2, t.berthcity, t.berthstate, t.berthzip, t.changedby, t.changeddate, t.entereddate,
        ROW_NUMBER() OVER (PARTITION BY t.polid, t.lobid, t.watrid ORDER BY t.effdate DESC) AS rn
      FROM afw_watercraft t
      WHERE t.polid = ANY($1::uuid[])
    ) t
    WHERE t.rn = 1 AND t.status != 'D'
    ORDER BY t.polid, t.lobid
  `,

}
