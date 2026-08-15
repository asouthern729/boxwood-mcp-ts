-- ============================================================================
-- boxwood_ams360_test seed data
-- ============================================================================
-- Fictional demo dataset: 15 customers in the fictional town of "Tyneside, TN"
-- (ZIP 37999 — not a real assigned USPS code). One customer, Tyneside
-- Innovations LLC, is a nod to the agency's own client-facing demo branding.
--
-- Run against boxwood_ams360_test only — never against boxwood_ams360 (the
-- real AMS360 replication target). To re-seed from scratch:
--
--   psql -h localhost -U andrew -d boxwood_ams360_test -f data/reset_test_data.sql
--   psql -h localhost -U andrew -d boxwood_ams360_test -f data/seed_test_data.sql
--
-- UUID convention (purely for human readability while cross-referencing rows
-- in this file — no meaning beyond that):
--   2xxxxxxx = agency/lookup entities (employees, brokers, companies, plans...)
--   80000000-...-00NN = customer NN
--   81-8Fxxxxxx = customer-domain child rows, prefixed by table, suffixed by
--                 owning customer number (a second digit in the prefix's last
--                 hex position marks a 2nd/3rd row for the same customer)
--   90000000-...-00NN = primary policy for customer NN (90000001- = 2nd policy)
--   91-94xxxxxx = policy-domain child rows, same suffix convention
--   A0/A1xxxxxx = invoices / transactions
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Agency lookup data (employees, broker, carriers, GL codes, payment plans,
-- lines of business, notations, attribute types, relationship types, xref
-- types) — everything the 15 customers/policies/invoices FK against.
-- ----------------------------------------------------------------------------

-- SYS is a self-referencing "system" employee used as changedby/enteredby
-- for bulk-seeded rows below, standing in for a data-migration/import actor
-- rather than attributing every seed row to a real staff member.
INSERT INTO afw_employee (
  empcode, empid, isrep, isprod, istelemarketer, isother, lastname, firstname,
  city, state, zip, isforeign, status, title, tzcode, bjeclosedstatus,
  islimitcustaccess, doc360hotspot, changedby, changeddate, entereddate
) VALUES
  ('SYS', '20000000-0000-0000-0000-000000000001', 'N', 'N', 'N', 'Y', 'System Seed', NULL, 'Tyneside', 'TN', '37999', 'N', 'A', 'Data Migration', 0, 'N', 'N', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  ('AJS', '20000000-0000-0000-0000-000000000002', 'N', 'Y', 'N', 'N', 'Sutton', 'Amanda', 'Tyneside', 'TN', '37999', 'N', 'A', 'Producer', 0, 'N', 'N', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  ('RTM', '20000000-0000-0000-0000-000000000003', 'N', 'Y', 'N', 'N', 'Malone', 'Robert', 'Tyneside', 'TN', '37999', 'N', 'A', 'Producer', 0, 'N', 'N', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  ('CLW', '20000000-0000-0000-0000-000000000004', 'Y', 'N', 'N', 'N', 'Whitfield', 'Carol', 'Tyneside', 'TN', '37999', 'N', 'A', 'CSR', 0, 'N', 'N', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  ('DPH', '20000000-0000-0000-0000-000000000005', 'Y', 'N', 'N', 'N', 'Hayes', 'David', 'Tyneside', 'TN', '37999', 'N', 'A', 'CSR', 0, 'N', 'N', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  ('MKR', '20000000-0000-0000-0000-000000000006', 'N', 'Y', 'N', 'N', 'Reyes', 'Michael', 'Tyneside', 'TN', '37999', 'N', 'A', 'Agency Principal', 0, 'N', 'N', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');

INSERT INTO afw_broker (
  brokerid, brokercode, lastname, firstname, shortname, city, state, zip,
  isforeign, iscompany, status, arcloseddate, arclosedstatus, ishide,
  bjeclosedstatus, changedby, changeddate, entereddate
) VALUES (
  '21000000-0000-0000-0000-000000000001', 'TBG', 'Tyneside Brokerage Group', NULL, 'TBG',
  'Tyneside', 'TN', '37999', 'N', 'Y', 'A', '1900-01-01', 'N', 'N', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'
);

INSERT INTO afw_generalledgerdivision (gldivcode, name, shortname, status, ishide, changedby, changeddate, entereddate) VALUES
  ('DIV', 'Main Division', 'Main', 'A', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');
INSERT INTO afw_generalledgerbranch (glbrnchcode, name, shortname, status, ishide, changedby, changeddate, entereddate) VALUES
  ('BR1', 'Main Branch', 'Main', 'A', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');
INSERT INTO afw_generalledgerdepartment (gldeptcode, name, shortname, status, ishide, changedby, changeddate, entereddate) VALUES
  ('DPT', 'Main Department', 'Main', 'A', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');
INSERT INTO afw_generalledgergroup (glgrpcode, name, shortname, status, ishide, changedby, changeddate, entereddate) VALUES
  ('GRP', 'Main Group', 'Main', 'A', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');

INSERT INTO afw_company (
  coid, cocode, name, shortname, type, status, ishide, naic, parentcocode,
  dlsavedata, usepolunspecified, usepriorpolno, isstoploss, bjeclosedstatus,
  dbstmtautomatchwriteco, dbstmtautomatchpolteffdate, dbstmtautomatchlobchgtype,
  dbstmtautomatchtrantype, dbstmtautomatchgrossamt, dbstmtautomatchagcycommamt,
  changedby, changeddate, entereddate
) VALUES
  ('22000000-0000-0000-0000-000000000001', 'CUMB', 'Cumberland Gap Mutual Insurance', 'Cumberland Gap', 'I', 'A', 'N', '99001', NULL, 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  ('22000000-0000-0000-0000-000000000002', 'RVRS', 'Riverstone Casualty & Surety', 'Riverstone', 'I', 'A', 'N', '99002', NULL, 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  ('22000000-0000-0000-0000-000000000003', 'APPL', 'Appalachian Underwriters Inc', 'Appalachian', 'I', 'A', 'N', '99003', 'CUMB', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');

INSERT INTO afw_paymentplan (paypid, acordcode, description, type, ishide, permflag, changedby, changeddate, entereddate) VALUES
  ('23000000-0000-0000-0000-000000000001', 'ANN', 'Annual Direct Bill', 'C', 'N', 1, 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  ('23000000-0000-0000-0000-000000000002', 'AB10', 'Agency Bill 10-Pay', 'C', 'N', 1, 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');

INSERT INTO afw_lobsetup (
  idlobs, namelobs, typeofbuslobs, descriptionlobs, permflaglobs, ishide,
  isboplobs, incomegrplobs, dlabstractionlobs, dlprocessinglobs,
  changedby, changeddate, entereddate
) VALUES
  (1, 'HOME', 1, 'Homeowners', 1, 'N', 'N', 'STD', 'STD', 0, 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  (2, 'PAUTO', 1, 'Personal Auto', 1, 'N', 'N', 'STD', 'STD', 0, 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  (3, 'BOP', 2, 'Businessowners Policy', 1, 'N', 'Y', 'STD', 'STD', 0, 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  (4, 'GL', 2, 'General Liability', 1, 'N', 'N', 'STD', 'STD', 0, 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  (5, 'CAUTO', 2, 'Commercial Auto', 1, 'N', 'N', 'STD', 'STD', 0, 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  (6, 'WC', 2, 'Workers Compensation', 1, 'N', 'N', 'STD', 'STD', 0, 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  (7, 'UMB', 1, 'Personal Umbrella', 1, 'N', 'N', 'STD', 'STD', 0, 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');

INSERT INTO afw_agencynotation (anotid, notationtype, description, permflag, ishide, changedby, changeddate, entereddate) VALUES
  ('24000000-0000-0000-0000-000000000001', 'C', 'VIP Account', 1, 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00'),
  ('24000000-0000-0000-0000-000000000002', 'C', 'Payment Watch', 1, 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');

INSERT INTO afw_customerattributetype (customerattributetypeid, customerattributetypename, customerattributetypedatatype, changedby, enteredby, changeddate, entereddate) VALUES
  (1, 'Referral Source', 'String', 'SYS', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');

INSERT INTO afw_policyattributetype (policyattributetypeid, policyattributetypename, policyattributetypedatatype, changedby, enteredby, changeddate, entereddate) VALUES
  (1, 'Renewal Priority', 'String', 'SYS', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');

INSERT INTO afw_relationshiptype (relationshiptypeid, category, relationshiptypedescription, "primary", secondary, active, changedby, changeddate, entereddate) VALUES
  ('25000000-0000-0000-0000-000000000001', 'P', 'Spousal / Household', 'Policyholder', 'Spouse', 'Y', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');

INSERT INTO afw_relationship (relationshipid, relationshipdescription, relationshiptypeid, changedby, changeddate, entereddate) VALUES
  ('26000000-0000-0000-0000-000000000001', 'Hollis Household', '25000000-0000-0000-0000-000000000001', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');

INSERT INTO afw_agencyxreftype (axrefid, description, permflag, ishide, changedby, changeddate, entereddate) VALUES
  ('27000000-0000-0000-0000-000000000001', 'Prior AMS System ID', 1, 'N', 'SYS', '2026-01-01 08:00:00', '2026-01-01 08:00:00');

-- afw_logicaltable is the type-code lookup behind every polymorphic
-- attachtype/entitytype/reftype column. It's a placeholder table upstream
-- too (see project notes) — key 1 stands in for "Customer" wherever this
-- seed data needs the polymorphic pair to resolve.
INSERT INTO afw_logicaltable (ltblkey) VALUES (1);


-- ----------------------------------------------------------------------------
-- Customers (15) — all in the fictional town of Tyneside, TN, ZIP 37999
-- ----------------------------------------------------------------------------

INSERT INTO afw_customer (
  custid, custno, lastname, firstname, addr1, city, state, zipcode, country,
  busareacode, busphone, email, dob, typecust, prod1code, csrcode,
  gldivcode, gldeptcode, glbrnchcode, glgrpcode, brokercode, anotid,
  mastersubtype, mastercustid,
  active, autoapplypay, stateprintgroup, autoapplycr, printcuststmt,
  arcloseddate, arclosedstatus, mktgflag, isexcldelete,
  isbillnamesameascust, isbilladdrsameascust, isprintagencybill, isprintdirectbill,
  premoption, groupingoption, isbrokcust, isderiveattrflagscust, permattrflagscust,
  issecured, sortname, joincriteria, changedby, changeddate, entereddate
) VALUES
  ('80000000-0000-0000-0000-000000000001', 1001, 'Tyneside Innovations LLC', NULL, '100 Innovation Way', 'Tyneside', 'TN', '37999', 'US', '423', '5550101', 'accounts@tynesideinnovations.example', NULL, 'C', 'MKR', 'CLW', 'DIV', 'DPT', 'BR1', 'GRP', 'TBG', '24000000-0000-0000-0000-000000000001', 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'Y', 'N', '', 'N', 'Tyneside Innovations LLC', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-000000000002', 1002, 'Smith', 'John', '214 Maple Street', 'Tyneside', 'TN', '37999', 'US', '423', '5550102', 'john.smith@example.com', '1980-04-12', 'P', 'AJS', 'DPH', 'DIV', 'DPT', 'BR1', 'GRP', NULL, NULL, 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Smith, John', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-000000000003', 1003, 'Smith', 'Karen', '88 Birchwood Lane', 'Tyneside', 'TN', '37999', 'US', '423', '5550103', 'karen.smith@example.com', '1975-09-03', 'P', 'AJS', 'DPH', 'DIV', 'DPT', 'BR1', 'GRP', NULL, NULL, 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Smith, Karen', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-000000000004', 1004, 'Riverbend Family Dental PLLC', NULL, '450 Riverbend Pkwy', 'Tyneside', 'TN', '37999', 'US', '423', '5550104', 'office@riverbenddental.example', NULL, 'C', 'RTM', 'CLW', 'DIV', 'DPT', 'BR1', 'GRP', NULL, NULL, 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Riverbend Family Dental PLLC', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-000000000005', 1005, 'Hollis Family Trust', NULL, '12 Heritage Trail', 'Tyneside', 'TN', '37999', 'US', '423', '5550105', 'hollisfamilytrust@example.com', NULL, 'C', 'MKR', 'CLW', 'DIV', 'DPT', 'BR1', 'GRP', NULL, NULL, 'M', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Hollis Family Trust', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-000000000006', 1006, 'Hollis', 'Marcus', '12 Heritage Trail', 'Tyneside', 'TN', '37999', 'US', '423', '5550106', 'marcus.hollis@example.com', '1972-02-20', 'P', 'MKR', 'CLW', 'DIV', 'DPT', 'BR1', 'GRP', NULL, NULL, 'S', '80000000-0000-0000-0000-000000000005', 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Hollis, Marcus', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-000000000007', 1007, 'Hollis', 'Diane', '12 Heritage Trail', 'Tyneside', 'TN', '37999', 'US', '423', '5550107', 'diane.hollis@example.com', '1974-11-08', 'P', 'MKR', 'CLW', 'DIV', 'DPT', 'BR1', 'GRP', NULL, NULL, 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Hollis, Diane', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-000000000008', 1008, 'Tyneside Volunteer Fire Auxiliary', NULL, '700 Firehouse Rd', 'Tyneside', 'TN', '37999', 'US', '423', '5550108', 'auxiliary@tynesidefire.example', NULL, 'C', 'RTM', 'DPH', 'DIV', 'DPT', 'BR1', 'GRP', NULL, NULL, 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Tyneside Volunteer Fire Auxiliary', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-000000000009', 1009, 'Big Ridge Outfitters Co.', NULL, '305 Big Ridge Rd', 'Tyneside', 'TN', '37999', 'US', '423', '5550109', 'info@bigridgeoutfitters.example', NULL, 'C', 'AJS', 'CLW', 'DIV', 'DPT', 'BR1', 'GRP', 'TBG', NULL, 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'Y', 'N', '', 'N', 'Big Ridge Outfitters Co.', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-00000000000a', 1010, 'Combs', 'Patricia', '19 Sunset Court', 'Tyneside', 'TN', '37999', 'US', '423', '5550110', 'patricia.combs@example.com', '1985-06-30', 'P', 'RTM', 'DPH', 'DIV', 'DPT', 'BR1', 'GRP', NULL, NULL, 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'Y', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Combs, Patricia', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-00000000000b', 1011, 'Eastbrook Manufacturing Inc.', NULL, '900 Industrial Pkwy', 'Tyneside', 'TN', '37999', 'US', '423', '5550111', 'ap@eastbrookmfg.example', NULL, 'C', 'MKR', 'CLW', 'DIV', 'DPT', 'BR1', 'GRP', NULL, NULL, 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Eastbrook Manufacturing Inc.', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-00000000000c', 1012, 'Whitlow', 'Sandra', '44 Willow Bend Dr', 'Tyneside', 'TN', '37999', 'US', '423', '5550112', 'sandra.whitlow@example.com', '1990-01-25', 'P', 'AJS', 'DPH', 'DIV', 'DPT', 'BR1', 'GRP', NULL, '24000000-0000-0000-0000-000000000002', 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Whitlow, Sandra', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-00000000000d', 1013, 'Blue Ridge Freight Logistics LLC', NULL, '1200 Freight Line Dr', 'Tyneside', 'TN', '37999', 'US', '423', '5550113', 'dispatch@blueridgefreight.example', NULL, 'C', 'RTM', 'CLW', 'DIV', 'DPT', 'BR1', 'GRP', NULL, NULL, 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Blue Ridge Freight Logistics LLC', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-00000000000e', 1014, 'Nichols', 'Harold', '65 Orchard Hill Rd', 'Tyneside', 'TN', '37999', 'US', '423', '5550114', 'harold.nichols@example.com', '1965-03-17', 'P', 'AJS', 'DPH', 'DIV', 'DPT', 'BR1', 'GRP', NULL, NULL, 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Nichols, Harold', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-00000000000f', 1015, 'Tyneside Family Diner LLC', NULL, '10 Main Street', 'Tyneside', 'TN', '37999', 'US', '423', '5550115', 'owner@tynesidediner.example', NULL, 'C', 'MKR', 'CLW', 'DIV', 'DPT', 'BR1', 'GRP', NULL, NULL, 'N', NULL, 'Y', 'N', 'N', 'N', 'Y', '1900-01-01', 'N', 'N', 'N', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', '', 'N', 'Tyneside Family Diner LLC', 'NONE', 'SYS', '2026-06-01 09:00:00', '2026-01-15 09:00:00');


-- ----------------------------------------------------------------------------
-- Customer-domain child records (contacts, dependents, loss history/claim,
-- attribute, relationship, cross-reference, expiring outside business,
-- service team)
-- ----------------------------------------------------------------------------

-- Officers on Tyneside Volunteer Fire Auxiliary (#1008)
INSERT INTO afw_custcontact (ccntid, custid, contactname, title, isofficer, isdirector, email, busareacode, busphone, custcenterdisplay, changedby, changeddate, entereddate) VALUES
  ('81000000-0000-0000-0000-000000000008', '80000000-0000-0000-0000-000000000008', 'Beth Ann Carver', 'President', 'Y', 'Y', 'beth.carver@example.com', '423', '5550118', 'Y', 'SYS', '2026-01-15 09:00:00', '2026-01-15 09:00:00'),
  ('81000001-0000-0000-0000-000000000008', '80000000-0000-0000-0000-000000000008', 'Owen T. Falk', 'Treasurer', 'Y', 'N', 'owen.falk@example.com', '423', '5550119', 'Y', 'SYS', '2026-01-15 09:00:00', '2026-01-15 09:00:00');

-- Dependents for John Smith (#1002)
INSERT INTO afw_dependent (depdid, custid, firstname, lastname, dob, married, relationship, changedby, changeddate, entereddate) VALUES
  ('82000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000002', 'Emily', 'Smith', '1982-07-19', 'Y', 'SPOU', 'SYS', '2026-01-15 09:00:00', '2026-01-15 09:00:00'),
  ('82000001-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000002', 'Noah', 'Smith', '2011-03-02', 'N', 'CHLD', 'SYS', '2026-01-15 09:00:00', '2026-01-15 09:00:00');

-- Customer attribute for Tyneside Innovations (#1001)
INSERT INTO afw_customerattribute (customerattributeid, custid, customerattributetypeid, customerattributevalue, changedby, enteredby, changeddate, entereddate) VALUES
  ('84000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 1, 'Chamber of Commerce', 'SYS', 'SYS', '2026-01-15 09:00:00', '2026-01-15 09:00:00');

-- Household relationship: Marcus (#1006, Primary) <-> Diane (#1007, Secondary)
INSERT INTO afw_customerrelationship (customerrelationshipid, relationshipid, custid, role, changedby, changeddate, entereddate) VALUES
  ('85000000-0000-0000-0000-000000000006', '26000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000006', 'P', 'SYS', '2026-01-15 09:00:00', '2026-01-15 09:00:00'),
  ('85000001-0000-0000-0000-000000000007', '26000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000007', 'S', 'SYS', '2026-01-15 09:00:00', '2026-01-15 09:00:00');

-- Cross-reference for Big Ridge Outfitters (#1009) — legacy AMS ID
INSERT INTO afw_custxref (cxrefid, custid, axrefid, xreference, changedby, changeddate, entereddate) VALUES
  ('86000000-0000-0000-0000-000000000009', '80000000-0000-0000-0000-000000000009', '27000000-0000-0000-0000-000000000001', 'LEGACY-BR-44219', 'SYS', '2026-01-15 09:00:00', '2026-01-15 09:00:00');

-- Expiring outside business for Patricia Combs (#1010) — a pure prospect, no policy with the agency yet
INSERT INTO afw_xdate (xdatid, custid, lineofbus, policyno, expdate, coname, agent, premium, acctsize, interestlevel, remarks, changedby, changeddate, entereddate) VALUES
  ('87000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-00000000000a', 'PAUTO', 'COMP-PA-88213', '2026-11-01', 'Statewide Auto Mutual', 'Direct Competitor Agency', 1140.00, 'M', 'H', 'Referred by neighbor (Karen Smith); currently insured elsewhere, expiring soon', 'SYS', '2026-01-15 09:00:00', '2026-01-15 09:00:00');

-- Service team beyond the primary producer/CSR
INSERT INTO afw_custaddpersonnel (caddpid, custid, empcode, typeofemp, typeofbus, isprimary, changedby, changeddate, entereddate) VALUES
  ('88000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 'RTM', 'R', 2, 'N', 'SYS', '2026-01-15 09:00:00', '2026-01-15 09:00:00'),
  ('88000001-0000-0000-0000-000000000008', '80000000-0000-0000-0000-000000000008', 'AJS', 'R', 2, 'N', 'SYS', '2026-01-15 09:00:00', '2026-01-15 09:00:00');

-- ----------------------------------------------------------------------------
-- Policies
-- ----------------------------------------------------------------------------

INSERT INTO afw_basicpolinfo (
  custid, polid, status, polno, shortpolno, typeofbus, poltype, poltypelob, polsubtype,
  cocode, cotype, writingcocode, execcode, csrcode, brokercode,
  poleffdate, polexpdate, iscontinuous, renewallist, renewalrptflag,
  ismultientity, multientityarflag, isposted, issuspended,
  gldivcode, gldeptcode, billmethod, paypid, instday, glbrnchcode, glgrpcode,
  billedstmtprem, fulltermpremium, isexcldelete, isfiltered,
  changedby, changeddate, entereddate
) VALUES
  ('80000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001', 'A', 'BOP-TN-1001', 'TN1001', 2, 'P', 'BOP', 'P', 'CUMB', 'C', 'CUMB', 'MKR', 'CLW', 'TBG', '2026-02-01', '2027-02-01', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'A', '23000000-0000-0000-0000-000000000002', 1, 'BR1', 'GRP', 0, 4800.00, 'N', 'N', 'SYS', '2026-02-01 09:00:00', '2026-01-15 09:00:00'),
  ('80000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000002', 'A', 'PA-TN-1002', 'TN1002', 1, 'P', 'PAUTO', 'P', 'CUMB', 'C', 'CUMB', 'AJS', 'DPH', NULL, '2026-03-01', '2027-03-01', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'D', '23000000-0000-0000-0000-000000000001', 1, 'BR1', 'GRP', 0, 1620.00, 'N', 'N', 'SYS', '2026-03-01 09:00:00', '2026-02-10 09:00:00'),
  ('80000000-0000-0000-0000-000000000003', '90000000-0000-0000-0000-000000000003', 'A', 'HO-TN-1003', 'TN1003', 1, 'P', 'HOME', 'P', 'RVRS', 'C', 'RVRS', 'AJS', 'DPH', NULL, '2026-04-01', '2027-04-01', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'D', '23000000-0000-0000-0000-000000000001', 1, 'BR1', 'GRP', 0, 1980.00, 'N', 'N', 'SYS', '2026-04-01 09:00:00', '2026-03-10 09:00:00'),
  ('80000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-000000000004', 'A', 'BOP-TN-1004', 'TN1004', 2, 'P', 'BOP', 'P', 'CUMB', 'C', 'CUMB', 'RTM', 'CLW', NULL, '2026-01-01', '2027-01-01', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'A', '23000000-0000-0000-0000-000000000002', 1, 'BR1', 'GRP', 0, 5200.00, 'N', 'N', 'SYS', '2026-01-01 09:00:00', '2025-12-10 09:00:00'),
  ('80000000-0000-0000-0000-000000000005', '90000000-0000-0000-0000-000000000005', 'A', 'UMB-TN-1005', 'TN1005', 1, 'P', 'UMB', 'P', 'RVRS', 'C', 'RVRS', 'MKR', 'CLW', NULL, '2026-05-01', '2027-05-01', 'Y', 'N', 'N', 'Y', 'N', 'Y', 'N', 'DIV', 'DPT', 'D', '23000000-0000-0000-0000-000000000001', 1, 'BR1', 'GRP', 0, 950.00, 'N', 'N', 'SYS', '2026-05-01 09:00:00', '2026-04-10 09:00:00'),
  ('80000000-0000-0000-0000-000000000006', '90000000-0000-0000-0000-000000000006', 'A', 'HO-TN-1006', 'TN1006', 1, 'P', 'HOME', 'P', 'RVRS', 'C', 'RVRS', 'MKR', 'CLW', NULL, '2026-05-01', '2027-05-01', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'D', '23000000-0000-0000-0000-000000000001', 1, 'BR1', 'GRP', 0, 2100.00, 'N', 'N', 'SYS', '2026-05-01 09:00:00', '2026-04-10 09:00:00'),
  ('80000000-0000-0000-0000-000000000008', '90000000-0000-0000-0000-000000000008', 'A', 'BOP-TN-1008', 'TN1008', 2, 'P', 'BOP', 'P', 'CUMB', 'C', 'CUMB', 'RTM', 'DPH', NULL, '2026-06-01', '2027-06-01', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'A', '23000000-0000-0000-0000-000000000002', 1, 'BR1', 'GRP', 0, 1800.00, 'N', 'N', 'SYS', '2026-06-01 09:00:00', '2026-05-10 09:00:00'),
  ('80000000-0000-0000-0000-000000000009', '90000000-0000-0000-0000-000000000009', 'A', 'BOP-TN-1009', 'TN1009', 2, 'P', 'BOP', 'P', 'APPL', 'C', 'APPL', 'AJS', 'CLW', 'TBG', '2026-06-15', '2027-06-15', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'A', '23000000-0000-0000-0000-000000000002', 1, 'BR1', 'GRP', 0, 3600.00, 'N', 'N', 'SYS', '2026-06-15 09:00:00', '2026-05-20 09:00:00'),
  ('80000000-0000-0000-0000-00000000000b', '90000000-0000-0000-0000-000000000011', 'A', 'WC-TN-1011', 'TN1011a', 2, 'P', 'WC', 'P', 'CUMB', 'C', 'CUMB', 'MKR', 'CLW', NULL, '2026-07-01', '2027-07-01', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'A', '23000000-0000-0000-0000-000000000002', 1, 'BR1', 'GRP', 0, 12500.00, 'N', 'N', 'SYS', '2026-07-01 09:00:00', '2026-06-10 09:00:00'),
  ('80000000-0000-0000-0000-00000000000b', '90000001-0000-0000-0000-000000000011', 'A', 'CA-TN-1011', 'TN1011b', 2, 'P', 'CAUTO', 'P', 'CUMB', 'C', 'CUMB', 'MKR', 'CLW', NULL, '2026-07-01', '2027-07-01', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'A', '23000000-0000-0000-0000-000000000002', 1, 'BR1', 'GRP', 0, 7400.00, 'N', 'N', 'SYS', '2026-07-01 09:00:00', '2026-06-10 09:00:00'),
  ('80000000-0000-0000-0000-00000000000c', '90000000-0000-0000-0000-000000000012', 'A', 'PA-TN-1012', 'TN1012', 1, 'P', 'PAUTO', 'P', 'CUMB', 'C', 'CUMB', 'AJS', 'DPH', NULL, '2026-02-15', '2027-02-15', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'D', '23000000-0000-0000-0000-000000000001', 1, 'BR1', 'GRP', 0, 1450.00, 'N', 'N', 'SYS', '2026-02-15 09:00:00', '2026-01-25 09:00:00'),
  ('80000000-0000-0000-0000-00000000000d', '90000000-0000-0000-0000-000000000013', 'A', 'CA-TN-1013', 'TN1013', 2, 'P', 'CAUTO', 'P', 'CUMB', 'C', 'CUMB', 'RTM', 'CLW', NULL, '2026-08-01', '2027-08-01', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'A', '23000000-0000-0000-0000-000000000002', 1, 'BR1', 'GRP', 0, 9100.00, 'N', 'N', 'SYS', '2026-08-01 09:00:00', '2026-07-05 09:00:00'),
  ('80000000-0000-0000-0000-00000000000e', '90000000-0000-0000-0000-000000000014', 'A', 'PKG-TN-1014', 'TN1014', 1, 'P', 'HOME', 'P', 'RVRS', 'C', 'RVRS', 'AJS', 'DPH', NULL, '2026-03-15', '2027-03-15', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'D', '23000000-0000-0000-0000-000000000001', 1, 'BR1', 'GRP', 0, 3050.00, 'N', 'N', 'SYS', '2026-03-15 09:00:00', '2026-02-20 09:00:00'),
  ('80000000-0000-0000-0000-00000000000f', '90000000-0000-0000-0000-000000000015', 'A', 'BOP-TN-1015', 'TN1015', 2, 'P', 'BOP', 'P', 'CUMB', 'C', 'CUMB', 'MKR', 'CLW', NULL, '2026-04-15', '2027-04-15', 'Y', 'N', 'N', 'N', 'N', 'Y', 'N', 'DIV', 'DPT', 'A', '23000000-0000-0000-0000-000000000002', 1, 'BR1', 'GRP', 0, 2700.00, 'N', 'N', 'SYS', '2026-04-15 09:00:00', '2026-03-20 09:00:00');

-- One "new business" transaction per policy at its effective date
INSERT INTO afw_policytransaction (polid, effdate, trantype, description, source, billednonprem, isuploaded, billmethodpolt, instdaypolt, paypid, isposted, changedby, changeddate, entereddate) VALUES
  ('90000000-0000-0000-0000-000000000001', '2026-02-01', 'N', 'New Business', 'E', 0, 'N', 'A', 1, '23000000-0000-0000-0000-000000000002', 'Y', 'SYS', '2026-02-01 09:00:00', '2026-01-15 09:00:00'),
  ('90000000-0000-0000-0000-000000000002', '2026-03-01', 'N', 'New Business', 'E', 0, 'N', 'D', 1, '23000000-0000-0000-0000-000000000001', 'Y', 'SYS', '2026-03-01 09:00:00', '2026-02-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000003', '2026-04-01', 'N', 'New Business', 'E', 0, 'N', 'D', 1, '23000000-0000-0000-0000-000000000001', 'Y', 'SYS', '2026-04-01 09:00:00', '2026-03-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000004', '2026-01-01', 'N', 'New Business', 'E', 0, 'N', 'A', 1, '23000000-0000-0000-0000-000000000002', 'Y', 'SYS', '2026-01-01 09:00:00', '2025-12-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000005', '2026-05-01', 'N', 'New Business', 'E', 0, 'N', 'D', 1, '23000000-0000-0000-0000-000000000001', 'Y', 'SYS', '2026-05-01 09:00:00', '2026-04-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000006', '2026-05-01', 'N', 'New Business', 'E', 0, 'N', 'D', 1, '23000000-0000-0000-0000-000000000001', 'Y', 'SYS', '2026-05-01 09:00:00', '2026-04-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000008', '2026-06-01', 'N', 'New Business', 'E', 0, 'N', 'A', 1, '23000000-0000-0000-0000-000000000002', 'Y', 'SYS', '2026-06-01 09:00:00', '2026-05-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000009', '2026-06-15', 'N', 'New Business', 'E', 0, 'N', 'A', 1, '23000000-0000-0000-0000-000000000002', 'Y', 'SYS', '2026-06-15 09:00:00', '2026-05-20 09:00:00'),
  ('90000000-0000-0000-0000-000000000011', '2026-07-01', 'N', 'New Business', 'E', 0, 'N', 'A', 1, '23000000-0000-0000-0000-000000000002', 'Y', 'SYS', '2026-07-01 09:00:00', '2026-06-10 09:00:00'),
  ('90000001-0000-0000-0000-000000000011', '2026-07-01', 'N', 'New Business', 'E', 0, 'N', 'A', 1, '23000000-0000-0000-0000-000000000002', 'Y', 'SYS', '2026-07-01 09:00:00', '2026-06-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000012', '2026-02-15', 'N', 'New Business', 'E', 0, 'N', 'D', 1, '23000000-0000-0000-0000-000000000001', 'Y', 'SYS', '2026-02-15 09:00:00', '2026-01-25 09:00:00'),
  ('90000000-0000-0000-0000-000000000013', '2026-08-01', 'N', 'New Business', 'E', 0, 'N', 'A', 1, '23000000-0000-0000-0000-000000000002', 'Y', 'SYS', '2026-08-01 09:00:00', '2026-07-05 09:00:00'),
  ('90000000-0000-0000-0000-000000000014', '2026-03-15', 'N', 'New Business', 'E', 0, 'N', 'D', 1, '23000000-0000-0000-0000-000000000001', 'Y', 'SYS', '2026-03-15 09:00:00', '2026-02-20 09:00:00'),
  ('90000000-0000-0000-0000-000000000015', '2026-04-15', 'N', 'New Business', 'E', 0, 'N', 'A', 1, '23000000-0000-0000-0000-000000000002', 'Y', 'SYS', '2026-04-15 09:00:00', '2026-03-20 09:00:00');

-- Lines of business (Tyneside Innovations and the Fire Auxiliary are BOP+GL
-- packages; the Nichols policy is a HOME+PAUTO package — everyone else is
-- single-LOB)
INSERT INTO afw_lineofbusiness (polid, lobid, effdate, expdate, lineofbus, writingcocode, description, insertseqno, changedby, changeddate, entereddate) VALUES
  ('90000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '2026-02-01', '2027-02-01', 'BOP', 'CUMB', 'Businessowners Policy', 1, 'SYS', '2026-02-01 09:00:00', '2026-01-15 09:00:00'),
  ('90000000-0000-0000-0000-000000000001', '91000001-0000-0000-0000-000000000001', '2026-02-01', '2027-02-01', 'GL', 'CUMB', 'General Liability', 1, 'SYS', '2026-02-01 09:00:00', '2026-01-15 09:00:00'),
  ('90000000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000002', '2026-03-01', '2027-03-01', 'PAUTO', 'CUMB', 'Personal Auto', 1, 'SYS', '2026-03-01 09:00:00', '2026-02-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000003', '2026-04-01', '2027-04-01', 'HOME', 'RVRS', 'Homeowners', 1, 'SYS', '2026-04-01 09:00:00', '2026-03-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000004', '91000000-0000-0000-0000-000000000004', '2026-01-01', '2027-01-01', 'BOP', 'CUMB', 'Businessowners Policy', 1, 'SYS', '2026-01-01 09:00:00', '2025-12-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000005', '91000000-0000-0000-0000-000000000005', '2026-05-01', '2027-05-01', 'UMB', 'RVRS', 'Personal Umbrella', 1, 'SYS', '2026-05-01 09:00:00', '2026-04-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000006', '91000000-0000-0000-0000-000000000006', '2026-05-01', '2027-05-01', 'HOME', 'RVRS', 'Homeowners', 1, 'SYS', '2026-05-01 09:00:00', '2026-04-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000008', '91000000-0000-0000-0000-000000000008', '2026-06-01', '2027-06-01', 'BOP', 'CUMB', 'Businessowners Policy', 1, 'SYS', '2026-06-01 09:00:00', '2026-05-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000008', '91000001-0000-0000-0000-000000000008', '2026-06-01', '2027-06-01', 'GL', 'CUMB', 'General Liability', 1, 'SYS', '2026-06-01 09:00:00', '2026-05-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000009', '91000000-0000-0000-0000-000000000009', '2026-06-15', '2027-06-15', 'BOP', 'APPL', 'Businessowners Policy', 1, 'SYS', '2026-06-15 09:00:00', '2026-05-20 09:00:00'),
  ('90000000-0000-0000-0000-000000000011', '91000000-0000-0000-0000-000000000011', '2026-07-01', '2027-07-01', 'WC', 'CUMB', 'Workers Compensation', 1, 'SYS', '2026-07-01 09:00:00', '2026-06-10 09:00:00'),
  ('90000001-0000-0000-0000-000000000011', '91000001-0000-0000-0000-000000000011', '2026-07-01', '2027-07-01', 'CAUTO', 'CUMB', 'Commercial Auto', 1, 'SYS', '2026-07-01 09:00:00', '2026-06-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000012', '91000000-0000-0000-0000-000000000012', '2026-02-15', '2027-02-15', 'PAUTO', 'CUMB', 'Personal Auto', 1, 'SYS', '2026-02-15 09:00:00', '2026-01-25 09:00:00'),
  ('90000000-0000-0000-0000-000000000013', '91000000-0000-0000-0000-000000000013', '2026-08-01', '2027-08-01', 'CAUTO', 'CUMB', 'Commercial Auto', 1, 'SYS', '2026-08-01 09:00:00', '2026-07-05 09:00:00'),
  ('90000000-0000-0000-0000-000000000014', '91000000-0000-0000-0000-000000000014', '2026-03-15', '2027-03-15', 'HOME', 'RVRS', 'Homeowners', 1, 'SYS', '2026-03-15 09:00:00', '2026-02-20 09:00:00'),
  ('90000000-0000-0000-0000-000000000014', '91000001-0000-0000-0000-000000000014', '2026-03-15', '2027-03-15', 'PAUTO', 'RVRS', 'Personal Auto', 1, 'SYS', '2026-03-15 09:00:00', '2026-02-20 09:00:00'),
  ('90000000-0000-0000-0000-000000000015', '91000000-0000-0000-0000-000000000015', '2026-04-15', '2027-04-15', 'BOP', 'CUMB', 'Businessowners Policy', 1, 'SYS', '2026-04-15 09:00:00', '2026-03-20 09:00:00');

-- A representative coverage row on the GL and package policies
INSERT INTO afw_coverage (polid, lobid, coverageid, effdate, status, attachid, attachtype, coveragecode, iscoverage, fulltermprem, limit1, limit2, deduct1, insertseqno, descrcov, changedby, changeddate, entereddate) VALUES
  ('90000000-0000-0000-0000-000000000001', '91000001-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', '2026-02-01', 'A', '90000000-0000-0000-0000-000000000001', 1, 'GL-OCC', 'Y', 1400.00, 1000000, 2000000, 0, 1, 'General Liability — Occurrence / Aggregate', 'SYS', '2026-02-01 09:00:00', '2026-01-15 09:00:00'),
  ('90000000-0000-0000-0000-000000000008', '91000001-0000-0000-0000-000000000008', '92000000-0000-0000-0000-000000000008', '2026-06-01', 'A', '90000000-0000-0000-0000-000000000008', 1, 'GL-OCC', 'Y', 900.00, 1000000, 2000000, 0, 1, 'General Liability — Occurrence / Aggregate', 'SYS', '2026-06-01 09:00:00', '2026-05-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000003', '92000000-0000-0000-0000-000000000003', '2026-04-01', 'A', '80000000-0000-0000-0000-000000000003', 1, 'DWELL', 'Y', 1980.00, 350000, 0, 1000, 1, 'Dwelling Coverage', 'SYS', '2026-04-01 09:00:00', '2026-03-10 09:00:00');

-- Policy personnel (commission split) — Eastbrook's WC policy shows a
-- producer + CSR split; every other policy gets a single primary producer row
INSERT INTO afw_policypersonnel (polid, polpid, empcode, emptype, isprimary, method, percentage, issuspended, negcommfieldscope, position, changedby, changeddate, entereddate) VALUES
  ('90000000-0000-0000-0000-000000000011', '93000000-0000-0000-0000-000000000011', 'MKR', 'P', 'Y', 'P', 70, 'N', 'N', 1, 'SYS', '2026-07-01 09:00:00', '2026-06-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000011', '93000001-0000-0000-0000-000000000011', 'CLW', 'R', 'N', 'P', 30, 'N', 'N', 2, 'SYS', '2026-07-01 09:00:00', '2026-06-10 09:00:00'),
  ('90000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000001', 'MKR', 'P', 'Y', 'P', 100, 'N', 'N', 1, 'SYS', '2026-02-01 09:00:00', '2026-01-15 09:00:00');

-- Policy attribute for Blue Ridge Freight Logistics (#1013)
INSERT INTO afw_policyattribute (policyattributeid, polid, policyattributetypeid, policyattributevalue, changedby, enteredby, changeddate, entereddate) VALUES
  ('94000000-0000-0000-0000-000000000013', '90000000-0000-0000-0000-000000000013', 1, 'High', 'SYS', 'SYS', '2026-08-01 09:00:00', '2026-07-05 09:00:00');

-- Claim + loss history summary for Riverbend Family Dental (#1004) — placed
-- here (not with the other customer-domain child records above) because it
-- FKs to the policy inserted in this section
INSERT INTO afw_claim (claimid, polid, lineofbus, causeofloss, lossdate, reportdate, claimno, claimstatus, closeddate, status, changedby, changeddate, entereddate) VALUES
  ('89000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-000000000004', 'BOP', 'Water Damage', '2026-03-02', '2026-03-03', 'CLM-2026-0417', 'Closed', '2026-04-20', 'C', 'SYS', '2026-04-20 09:00:00', '2026-03-03 09:00:00');

INSERT INTO afw_custlosshist (closshistid, custid, claimid, company, polno, kindofloss, lineofbus, poleffdate, polexpdate, amountpaid, dateofloss, claimstatus, claimno, closeddate, lossdescclhis, changedby, changeddate, entereddate) VALUES
  ('83000000-0000-0000-0000-000000000004', '80000000-0000-0000-0000-000000000004', '89000000-0000-0000-0000-000000000004', 'Cumberland Gap Mutual Insurance', 'BOP-TN-1004', 'Water Damage', 'BOP', '2026-01-01', '2027-01-01', 8400.00, '2026-03-02', 'Closed', 'CLM-2026-0417', '2026-04-20', 'Burst pipe in second-floor break room damaged ceiling and equipment in the operatory below.', 'SYS', '2026-04-20 09:00:00', '2026-03-03 09:00:00');


-- ----------------------------------------------------------------------------
-- Invoices + activity log
-- ----------------------------------------------------------------------------

INSERT INTO afw_invoice (
  invid, invseriesid, custid, polid, invtype, inveffdate, invdate, duedate, invno,
  polrelation, polno, gldivcode, gldeptcode, glbrnchcode, glgrpcode,
  brokercode, execcode, repcode, isinstallment, iscancelled, binderstatus,
  closeddate, closedstatus, arcloseddate, arclosedstatus, dbreccloseddate,
  ispre35data, isposted, originalinvidinv, voidinvidinv,
  changedby, changeddate, entereddate
) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001', 1, '2026-02-01', '2026-02-01', '2026-02-15', 5001, 'P', 'BOP-TN-1001', 'DIV', 'DPT', 'BR1', 'GRP', 'TBG', 'MKR', 'CLW', 'Y', 'N', 'N', '2026-02-10', 'Y', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-02-01 09:00:00', '2026-02-01 09:00:00'),
  ('a0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000001', 1, '2026-05-01', '2026-05-01', '2026-05-15', 5002, 'P', 'BOP-TN-1001', 'DIV', 'DPT', 'BR1', 'GRP', 'TBG', 'MKR', 'CLW', 'Y', 'N', 'N', '1900-01-01', 'N', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-05-01 09:00:00', '2026-05-01 09:00:00'),
  ('a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000002', 1, '2026-03-01', '2026-03-01', '2026-03-15', 5003, 'P', 'PA-TN-1002', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'AJS', 'DPH', 'N', 'N', 'N', '2026-03-12', 'Y', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-03-01 09:00:00', '2026-03-01 09:00:00'),
  ('a0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', '80000000-0000-0000-0000-000000000003', '90000000-0000-0000-0000-000000000003', 1, '2026-04-01', '2026-04-01', '2026-04-15', 5004, 'P', 'HO-TN-1003', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'AJS', 'DPH', 'N', 'N', 'N', '2026-04-11', 'Y', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-04-01 09:00:00', '2026-04-01 09:00:00'),
  ('a0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000004', '80000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-000000000004', 1, '2026-01-01', '2026-01-01', '2026-01-15', 5005, 'P', 'BOP-TN-1004', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'RTM', 'CLW', 'Y', 'N', 'N', '2026-01-12', 'Y', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-01-01 09:00:00', '2026-01-01 09:00:00'),
  ('a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000005', '80000000-0000-0000-0000-000000000005', '90000000-0000-0000-0000-000000000005', 1, '2026-05-01', '2026-05-01', '2026-05-15', 5006, 'P', 'UMB-TN-1005', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'MKR', 'CLW', 'N', 'N', 'N', '2026-05-09', 'Y', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-05-01 09:00:00', '2026-05-01 09:00:00'),
  ('a0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000006', '80000000-0000-0000-0000-000000000006', '90000000-0000-0000-0000-000000000006', 1, '2026-05-01', '2026-05-01', '2026-05-15', 5007, 'P', 'HO-TN-1006', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'MKR', 'CLW', 'N', 'N', 'N', '2026-05-10', 'Y', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-05-01 09:00:00', '2026-05-01 09:00:00'),
  ('a0000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000008', '80000000-0000-0000-0000-000000000008', '90000000-0000-0000-0000-000000000008', 1, '2026-06-01', '2026-06-01', '2026-06-15', 5008, 'P', 'BOP-TN-1008', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'RTM', 'DPH', 'Y', 'N', 'N', '1900-01-01', 'N', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-06-01 09:00:00', '2026-06-01 09:00:00'),
  ('a0000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000009', '80000000-0000-0000-0000-000000000009', '90000000-0000-0000-0000-000000000009', 1, '2026-06-15', '2026-06-15', '2026-06-29', 5009, 'P', 'BOP-TN-1009', 'DIV', 'DPT', 'BR1', 'GRP', 'TBG', 'AJS', 'CLW', 'Y', 'N', 'N', '1900-01-01', 'N', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-06-15 09:00:00', '2026-06-15 09:00:00'),
  ('a0000000-0000-0000-0000-000000000011', 'a0000000-0000-0000-0000-000000000011', '80000000-0000-0000-0000-00000000000b', '90000000-0000-0000-0000-000000000011', 1, '2026-07-01', '2026-07-01', '2026-07-15', 5010, 'P', 'WC-TN-1011', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'MKR', 'CLW', 'Y', 'N', 'N', '1900-01-01', 'N', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-07-01 09:00:00', '2026-07-01 09:00:00'),
  ('a0000001-0000-0000-0000-000000000011', 'a0000001-0000-0000-0000-000000000011', '80000000-0000-0000-0000-00000000000b', '90000001-0000-0000-0000-000000000011', 1, '2026-07-01', '2026-07-01', '2026-07-15', 5011, 'P', 'CA-TN-1011', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'MKR', 'CLW', 'Y', 'N', 'N', '1900-01-01', 'N', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-07-01 09:00:00', '2026-07-01 09:00:00'),
  -- Sandra Whitlow: original invoice later corrected — original is marked voided, pointing at the correction
  ('a0000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000012', '80000000-0000-0000-0000-00000000000c', '90000000-0000-0000-0000-000000000012', 1, '2026-02-15', '2026-02-15', '2026-03-01', 5012, 'P', 'PA-TN-1012', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'AJS', 'DPH', 'N', 'Y', 'N', '1900-01-01', 'N', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, 'a0000001-0000-0000-0000-000000000012', 'SYS', '2026-02-15 09:00:00', '2026-02-15 09:00:00'),
  ('a0000001-0000-0000-0000-000000000012', 'a0000001-0000-0000-0000-000000000012', '80000000-0000-0000-0000-00000000000c', '90000000-0000-0000-0000-000000000012', 1, '2026-02-20', '2026-02-20', '2026-03-06', 5013, 'P', 'PA-TN-1012', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'AJS', 'DPH', 'N', 'N', 'N', '1900-01-01', 'N', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', 'a0000000-0000-0000-0000-000000000012', NULL, 'SYS', '2026-02-20 09:00:00', '2026-02-20 09:00:00'),
  ('a0000000-0000-0000-0000-000000000013', 'a0000000-0000-0000-0000-000000000013', '80000000-0000-0000-0000-00000000000d', '90000000-0000-0000-0000-000000000013', 1, '2026-08-01', '2026-08-01', '2026-08-15', 5014, 'P', 'CA-TN-1013', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'RTM', 'CLW', 'Y', 'N', 'N', '1900-01-01', 'N', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
  ('a0000000-0000-0000-0000-000000000014', 'a0000000-0000-0000-0000-000000000014', '80000000-0000-0000-0000-00000000000e', '90000000-0000-0000-0000-000000000014', 1, '2026-03-15', '2026-03-15', '2026-03-29', 5015, 'P', 'PKG-TN-1014', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'AJS', 'DPH', 'N', 'N', 'N', '2026-03-25', 'Y', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-03-15 09:00:00', '2026-03-15 09:00:00'),
  ('a0000000-0000-0000-0000-000000000015', 'a0000000-0000-0000-0000-000000000015', '80000000-0000-0000-0000-00000000000f', '90000000-0000-0000-0000-000000000015', 1, '2026-04-15', '2026-04-15', '2026-04-29', 5016, 'P', 'BOP-TN-1015', 'DIV', 'DPT', 'BR1', 'GRP', NULL, 'MKR', 'CLW', 'Y', 'N', 'N', '1900-01-01', 'N', '1900-01-01', 'N', '1900-01-01', 'N', 'Y', NULL, NULL, 'SYS', '2026-04-15 09:00:00', '2026-04-15 09:00:00');

-- Activity log entries (afw_transaction) tied to a couple of policies, for
-- invoice_lookup's "activity" include
INSERT INTO afw_transaction (tranid, entityid, entitytype, polid, dbaction, trandate, empcode, polno, execcode, csrcode, trantype, commenttran, changedby, changeddate, entereddate) VALUES
  ('a1000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 1, '90000000-0000-0000-0000-000000000001', 'I', '2026-01-20 10:15:00', 'MKR', 'BOP-TN-1001', 'MKR', 'CLW', 'N', 'Initial quote presented to Tyneside Innovations LLC; bundled BOP + GL per client request.', 'SYS', '2026-01-20 10:15:00', '2026-01-20 10:15:00'),
  ('a1000001-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 1, '90000000-0000-0000-0000-000000000001', 'I', '2026-02-01 14:00:00', 'CLW', 'BOP-TN-1001', 'MKR', 'CLW', 'N', 'Policy bound. Welcome packet and certificate of insurance sent.', 'SYS', '2026-02-01 14:00:00', '2026-02-01 14:00:00'),
  ('a1000000-0000-0000-0000-000000000011', '80000000-0000-0000-0000-00000000000b', 1, '90000000-0000-0000-0000-000000000011', 'I', '2026-06-25 11:30:00', 'MKR', 'WC-TN-1011', 'MKR', 'CLW', 'N', 'Payroll audit worksheet requested from client ahead of binding.', 'SYS', '2026-06-25 11:30:00', '2026-06-25 11:30:00');
