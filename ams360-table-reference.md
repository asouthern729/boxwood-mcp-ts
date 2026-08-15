# AMS360 Table Reference

Purpose and intent of each `afw_` table synced into the Boxwood-Tyneside Postgres database. Intended as context for the MCP server's query tool and any future Claude Code skills working with this data.

---

## Pending Foreign Keys

Columns already in place that reference tables not yet built. Add the constraint (see pattern used for `afw_customerattribute` → `afw_customerattributetype`) once each target table exists.

| Column | Referencing table(s) | Target table (not yet built) |
|---|---|---|
| `changedby` (genuinely ambiguous — spec gives `char(3)` with no explicit EmpCode source) | afw_customerrelationship, afw_relationship, afw_relationshiptype, afw_businessunitaccess | afw_employee.empcode — confirm real sync data before enforcing |
| `xdatlineofbus` | afw_leadlist | afw_PRCode lookup, AttrCode='LB' — likely PRCode lookup table, not yet built |
| `plantype` | afw_lineofbusiness | afw_plansetup.descriptionpln |
| `elfformverid` | afw_lineofbusiness | afw_elfformversion.elfformverid |
| `underwriter` | afw_basicpolinfo | afw_underwriter.name (lookup) |
| `binderreplacepolteffdate` | afw_policytransaction | self-referencing (another row's effdate within same policy) — composite relationship, not FK-enforced |
| `masteragent` | afw_basicpolinfo | afw_masteragent.masteragent |
| `ticomid` | afw_basicpolinfo | afw_defaulttieredcommission.ticomid |
| `istid` | afw_basicpolinfo | afw_invoicesplittemplate.istid |
| `changedby` (sentinel `'^^^'` for migrated rows, not a real empcode) | afw_policychklstdetail, afw_policychklstheader | not FK-enforceable — intentional |
| `chargecodepoltp` | afw_policytranpremium | afw_setupbillingtran.chargecode |
| `collectionid` | afw_invoice | afw_invoicecollection.collectionid |
| `bhid` | afw_invoice | afw_billingheader.bhid |
| `invtype` | afw_invoice | afw_constant.constantcvalue (where constantname like '%INV_TYPE%') |
| `journaltranid` | afw_invoice | GL journal link — target table not identified in spec, left unenforced |

**Not resolving:** `elfformtypeid` (afw_lobsetup) and `elfformid` (afw_claim) — `afw_elfformtype` is not a real table per the ERD; these stay as plain unenforced UUID columns.

**Skipped by decision:** `afw_timezone` — only referenced once (afw_employee.tzcode), low query value. `tzcode` stays a plain unenforced smallint on afw_employee.

**Correction:** `afw_custxref`, `afw_dependent`, `afw_profileanswer`, and `afw_xdate` all explicitly spec `ChangedBy` as `From AFW_Employee.EmpCode` in the AMS360 doc — these were mistakenly grouped with the genuinely ambiguous tables earlier and left unenforced. Claude Code correctly added the FK on `afw_xdate.changedby` independently; the same FK has now been added to the other three (column type changed `text` → `varchar(3)` to match `afw_employee.empcode`). Only `afw_customerrelationship`, `afw_relationship`, `afw_relationshiptype`, and `afw_businessunitaccess` remain genuinely ambiguous (spec says plain `char(3)`, no explicit source table).

**Policy table group — General Tables (4.3.3) complete:** `afw_basicpolinfo`, `afw_policytransaction`, `afw_lineofbusiness` (Phase 1 scope), `afw_address`, `afw_polcontact`, `afw_policypersonnel`, `afw_policypersonnelperiods`, `afw_submission`, `afw_submissiongroup`, `afw_commissiontemplate`, `afw_commissiontemplatepersonnel`, `afw_externalentity`, `afw_fieldimportance`, `afw_phonenumber`, `afw_policyattribute`, `afw_policyattributetype`, `afw_policychklstdetail`, `afw_policychklstheader`, `afw_policysubcustomer`, `afw_policytranpremium`, plus `afw_coverage` (pulled forward from the deferred Policy History group since `afw_claim` needed it). `polid`/`lobid` on `afw_claim` now enforced; `subgrid` on `afw_submission` now enforced; `causeofloss` on `afw_claim` now resolved as a lookup against `afw_coverage.coveragecode`. Remaining ~189 Policy History tables (section 4.4.3) stay deferred per earlier decision.

**Invoice table group — Phase 1 scope complete:** `afw_invoice` and `afw_transaction` built, closing out the original `invoice_lookup` MCP tool scope. All three Phase 1 tools (`customer_lookup`, `policy_query`, `invoice_lookup`) now have full underlying schema support.

**Skipped by decision:** AMS360's ~190 Policy History tables (doc section 4.4.3 — per-ACORD-form line-item detail: vehicles, buildings, boats, farm equipment, crime/EPL specifics, etc.) are deferred indefinitely. Only populated when that specific coverage type exists on a policy; low value for conversational MCP queries relative to build effort. Revisit selectively if a specific client need surfaces.

**Resolved this round:** `empcode`/`prod1code`/`csrcode`/`changedby`/`enteredby` on afw_customer, afw_custcontact, afw_custaddpersonnel, afw_custcontactresp, afw_custlosshist, afw_customerattribute, afw_customerattributetype now enforced against `afw_employee.empcode`; `lineofbus` on afw_custlosshist and afw_xdate now enforced against `afw_lobsetup.namelobs`; `brokercode` on afw_customer now enforced against `afw_broker.brokercode`; `llid` on afw_customer now enforced against `afw_leadlist.llid`; `anotid` on afw_customer and afw_leadlist now enforced against `afw_agencynotation.anotid`; `claimid` on afw_custlosshist now enforced against `afw_claim.claimid`; `axrefid` on afw_custxref now enforced against `afw_agencyxreftype.axrefid`; `relationshiptypeid` on afw_relationship now enforced against `afw_relationshiptype.relationshiptypeid`; `questionid` on afw_profileanswer now enforced against `afw_profilequestion.questionid`; `imageid` on afw_employee now enforced against `afw_image.imageid`; `s1099category`/`s1099type` on afw_employee and afw_broker now enforced (composite FK) against `afw_setup1099`; `buacsid` on afw_employee now enforced against `afw_businessunitaccess.buacsid`; `gldivcode`/`defaultgldivcode` on afw_customer, afw_leadlist, and afw_employee now enforced against `afw_generalledgerdivision.gldivcode`; `glbrnchcode`/`defaultglbrnchcode` on afw_customer, afw_leadlist, and afw_employee now enforced against `afw_generalledgerbranch.glbrnchcode`; `gldeptcode`/`defaultgldeptcode` on afw_customer, afw_leadlist, and afw_employee now enforced against `afw_generalledgerdepartment.gldeptcode`; `glgrpcode`/`defaultglgrpcode` on afw_customer, afw_leadlist, and afw_employee now enforced against `afw_generalledgergroup.glgrpcode`.

**Customer table group: all loose ends resolved.** Every FK originating from the 13 customer-domain tables and their supporting lookup/employee/GL tables is now enforced, except the intentionally-deferred items above (untyped `changedby` columns, `afw_PRCode`/`afw_coverage` generic lookups, and the three policy-domain references on `afw_claim` that wait for that table group).

---

## afw_customer

**Represents:** The core/parent record for every customer, prospect, or suspect in the agency. One row per customer entity.

**Contains:** Name, address, contact numbers, demographic info, billing preferences and address, accounting options (statement printing, AR settings, invoice grouping), marketing/solicitation preferences, and agency assignment (producer/CSR codes).

**Key relationships:**
- `custid` (PK) is referenced as a foreign key throughout the rest of the schema — nearly every other customer-related table hangs off this.
- `mastercustid` self-references `afw_customer` for Multiple Entity / sub-customer setups (`mastersubtype` = M/S).
- `prod1code`, `csrcode`, `changedby` reference `afw_employee.empcode` (producer, account rep, and last editor).
- `brokercode` references `afw_broker`.

**Typical use in MCP queries:** Customer lookup by name/number, pulling a customer's billing/contact profile, identifying which employee (producer/CSR) owns an account.

---

## afw_custcontact

**Represents:** Individual contact people associated with a customer (e.g. officers, directors, or other named contacts at a commercial account). One row per contact.

**Contains:** Contact name, title, officer/director flags, address, phone numbers (residence/business/fax/mobile/pager), email, salutations, preferred contact method, and notes.

**Key relationships:**
- `custid` (FK) ties each contact back to its parent `afw_customer` row.
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** "Who are the contacts on this account," pulling contact info for a specific customer, identifying officers/directors on a commercial account.

---

## afw_custaddpersonnel

**Represents:** Additional agency personnel assigned to a customer beyond the primary producer/CSR — set up under "Service Groups" on the customer window. One row per person-role-business-line assignment.

**Contains:** Which employee, their role type (Broker/Exec/Rep/Sales Center Rep), which line of business they're assigned to (Personal, Commercial, Life, Health, etc.), and whether they're the primary contact for that assignment.

**Key relationships:**
- `custid` (FK) ties the assignment back to `afw_customer`.
- `empcode` and `changedby` reference `afw_employee.empcode`.
- No unique constraint on (empcode, typeofemp) per AMS360 design — a person can appear multiple times for a customer across different business lines.

**Typical use in MCP queries:** "Who else is assigned to this account besides the primary CSR," identifying service team coverage by line of business.

---

## afw_custcontactresp

**Represents:** Responsibility tags assigned to a customer contact (e.g. what role/responsibility that person has). One row per responsibility assigned to a contact — a contact can have multiple.

**Contains:** Responsibility type code (lookup value), plus standard change/entry tracking.

**Key relationships:**
- `ccntid` (FK) ties each responsibility back to `afw_custcontact`.
- `resptype` is a lookup code (`afw_PRCode` where `AttrCode = 'RES'`) — not resolved to a description here.
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** "What is this contact responsible for" — usually joined with `afw_custcontact` to answer contact-level questions.

---

## afw_custlosshist

**Represents:** Loss/claims history for a customer — both prior losses that occurred before they became a client and a summary of claims tracked in AMS360. One row per loss/claim record.

**Contains:** Carrier, policy number, cause of loss, line of business, policy effective/expiration dates, amount paid, date of loss, claim status, claim number, closed date, and a free-text loss description.

**Key relationships:**
- `custid` (FK) ties the record to `afw_customer`.
- `claimid` optionally references `afw_claim.claimid` when the loss is tracked as a full claim record in AMS360.
- `lineofbus` references `afw_lobsetup.namelobs`.
- `kindofloss` and `claimstatus` are lookup codes (`afw_PRCode`, AttrCode 'KO' and 'CS' respectively).
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** Underwriting/renewal prep — "what's this customer's loss history," claims frequency and severity summaries.

---

## afw_customerattribute

**Represents:** Generic key/value attribute data attached to a customer — an extensible EAV (entity-attribute-value) table rather than fixed columns. One row per attribute value assigned to a customer.

**Contains:** Which customer, which attribute type (via `customerattributetypeid`), and the value itself (stored as text).

**Key relationships:**
- `custid` (FK) ties the attribute to `afw_customer`.
- `customerattributetypeid` references `afw_customerattributetype` (not yet built — the attribute type's name/meaning lives there, so this table's values aren't self-describing on their own).
- `changedby` / `enteredby` reference `afw_employee.empcode`.

**Typical use in MCP queries:** Join with `afw_customerattributetype` (now built) to resolve attribute name/data type — answers "what custom attributes does this customer have."

---

## afw_customerattributetype

**Represents:** Lookup/definition table for the attribute types referenced by `afw_customerattribute`. One row per distinct custom attribute the agency has defined.

**Contains:** Attribute name (label) and its data type (how the raw value in `afw_customerattribute.customerattributevalue` should be interpreted — string, number, date, etc.).

**Key relationships:**
- Referenced by `afw_customerattribute.customerattributetypeid` — required to make sense of that table's values.
- `changedby` / `enteredby` reference `afw_employee.empcode`.

**Typical use in MCP queries:** Joined with `afw_customerattribute` to resolve attribute names/types — build both together, `afw_customerattribute` is not useful on its own.

---

## afw_customerrelationship

**Represents:** Maps a customer to a relationship group and their role within it (e.g. linking spouses, business partners, or members of a household/group). One row per customer-to-relationship membership.

**Contains:** Which relationship instance, which customer, and their role in it (Primary/Secondary for parent-child style relationships, or Member for group relationships).

**Key relationships:**
- `custid` (FK) ties the membership to `afw_customer`.
- `relationshipid` references `afw_relationship` (not yet built — that table presumably defines the relationship instance/type itself).

**Typical use in MCP queries:** "Who is related to this customer and how" — household/business relationship mapping. Joined with `afw_relationship` (now built) for the relationship description; full role/type semantics still need `afw_relationshiptype`.

---

## afw_relationship

**Represents:** A defined relationship instance that links customers together (e.g. "Smith Household," "Acme + Subsidiary"). One row per relationship instance.

**Contains:** A description and a link to the relationship's type.

**Key relationships:**
- Referenced by `afw_customerrelationship.relationshipid` — this is the instance each customer-membership row points to.
- `relationshiptypeid` references `afw_relationshiptype` (not yet built — defines whether it's a Parent/Child vs. Group type relationship).

**Typical use in MCP queries:** Joined with `afw_customerrelationship` to answer "what households/groups exist and who's in them." Description resolves without the type table, but role semantics (Primary/Secondary vs Member) depend on `afw_relationshiptype`.

---

## afw_custxref

**Represents:** Cross-reference values for a customer — external/alternate identifiers the agency uses to look up the customer (e.g. an ID from another system). One row per cross-reference entry.

**Contains:** The cross-reference value itself, and its type.

**Key relationships:**
- `custid` (FK) ties the cross-reference to `afw_customer`.
- `axrefid` references `afw_agencyxreftype` (not yet built — defines what kind of cross-reference this is, e.g. prior AMS system ID, carrier account number).

**Typical use in MCP queries:** "Find this customer by their [other system] ID" — useful for cross-system lookups once `afw_agencyxreftype` resolves the reference type label.

---

## afw_dependent

**Represents:** Dependents associated with a customer (spouse, children, other household/family members) — most relevant for personal lines and benefits. One row per dependent.

**Contains:** Name, contact info (residence/business/fax/mobile/pager phones, email), SSN, DOB, driver's license, marital status, occupation, relationship to the customer, employment year, and education level.

**Key relationships:**
- `custid` (FK) ties the dependent to `afw_customer`.
- `changedby` references `afw_employee.empcode`.
- `married`, `relationship`, and `educationlevel` are lookup codes (`afw_PRCode`, AttrCode 'MS', 'REL', 'EDL' respectively).

**Typical use in MCP queries:** Personal lines / benefits questions — "who are this customer's dependents," household composition for quoting or benefits guide generation (relevant to the Tim Potter benefits project).

---

## afw_profileanswer

**Represents:** A customer's answer to a specific profile question — used for underwriting/marketing profiling questionnaires. One row per (customer, question) pair.

**Contains:** The answer text, keyed by customer and question.

**Key relationships:**
- `custid` (FK) ties the answer to `afw_customer`.
- `questionid` references `afw_profilequestion` (not yet built — holds the actual question text/wording).
- `changedby` references `afw_employee.empcode`.
- No dedicated row ID in the AMS360 spec — PK is the composite (`custid`, `questionid`).

**Typical use in MCP queries:** Not useful standalone — needs `afw_profilequestion` synced to resolve what each answer is actually answering.

---

## afw_xdate

**Represents:** Expiration dates for policies a prospect/customer holds elsewhere — i.e. business not currently written by this agency but tracked for future solicitation. One row per outside policy being tracked.

**Contains:** Line of business, competitor policy number, expiration date, competing carrier name, current agent of record, premium, account size tier, interest level (likelihood of winning the business), and remarks.

**Key relationships:**
- `custid` (FK) ties the record to `afw_customer`.
- `lineofbus` references `afw_lobsetup.namelobs`.
- `acctsize` and `interestlevel` are lookup codes (`afw_PRString`, AttrCode '24' and '25' respectively).
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** High value — this is prospecting/rounding-out data. "What outside business is expiring soon that we could quote," sales pipeline / marketing queries by expiration date or interest level.

---

## afw_employee

**Represents:** Every employee set up in the agency — producers, CSRs, sales center reps, and other staff. One row per employee.

**Contains:** Name, contact info, role flags (rep/producer/telemarketer/other — controls which dropdown lists they appear in), title, supervisor, employment status (Active/Inactive/Retired/Deleted/Service), license status, GL defaults, and business unit access.

**Key relationships:**
- `empcode` is the PK and the value referenced throughout the rest of the schema (`prod1code`, `csrcode`, `changedby`, `enteredby`, `empcode` FK columns on other tables).
- `empsupervisorcode` self-references `afw_employee.empcode`.
- AMS360 also tracks a separate `empid` (uuid) flagged in the source doc as "more unique" than `empcode` since the 3-character code isn't guaranteed unique agency-wide — kept here as a unique alternate key, but `empcode` remains the FK target since that's what every other table's spec points to.
- `imageid`, `s1099category`/`s1099type`, `buacsid`, and the `defaultgl*` codes reference setup tables not yet built (image, 1099 setup, business unit access, GL division/branch/department/group). `tzcode` intentionally left as a plain unenforced value — `afw_timezone` was skipped (single reference, low query value).

**Typical use in MCP queries:** Resolving employee names/roles behind any `changedby`, `prod1code`, `csrcode`, or `empcode` value elsewhere in the schema — almost every other query will eventually join here.

---

## afw_lobsetup

**Represents:** Setup/lookup table defining the agency's Lines of Business (LOBs) — e.g. specific ACORD-coded coverage lines. One row per LOB the agency has configured (permanent ACORD-defined or user-added).

**Contains:** LOB code and description, business type category (Personal/Commercial/Benefits/Life/Health/Financial Services/etc.), whether it's a permanent or user-defined row, UI form assignment, BOP flag, income group classification, and download processing rules.

**Key relationships:**
- `idlobs` is the PK; `namelobs` is a unique alternate key and is what other tables actually reference (`afw_custlosshist.lineofbus`, `afw_xdate.lineofbus`) per the AMS360 spec text.
- `elfformtypeid` — comment field only; not backed by a real table (confirmed no `afw_elfformtype` in the ERD), left as a plain UUID.
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** Resolving line-of-business codes to human-readable descriptions and business-type categories across loss history, expiring business, and (later) policy tables.

---

## afw_broker

**Represents:** Brokers the agency works with — either individuals or firms — used when a customer's business is placed through a broker rather than direct with a carrier. One row per broker.

**Contains:** Name (or firm name if `iscompany` = Y), contact info, tax ID, net commission flag, 1099 category/type, AR closed status, and standard change tracking.

**Key relationships:**
- `brokerid` is the PK; `brokercode` is a unique alternate key and is what `afw_customer.brokercode` actually references per the AMS360 spec text.
- `s1099category`/`s1099type` reference `afw_setup1099` (not yet built).
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** Resolving which broker a customer's business runs through — relevant for commercial accounts placed via broker relationships.

---

## afw_leadlist

**Represents:** Header/metadata for an imported marketing lead list batch. One row per lead list import.

**Contains:** Description, target customer type (Customer/Prospect/Suspect), default GL assignment and producer/CSR to apply to imported records, line of business for imported X-date info, and import status/progress.

**Key relationships:**
- Referenced by `afw_customer.llid` when a customer originated from a lead list import.
- `custprod1code`/`custcsrcode`/`changedby` reference `afw_employee.empcode`.
- `custanotid` references `afw_agencynotation` (not yet built).
- `gldeptcode`/`gldivcode`/`glbrnchcode`/`glgrpcode` reference GL setup tables (not yet built).

**Typical use in MCP queries:** Tracing which customers originated from a specific marketing import batch, and that batch's import status.

---

## afw_agencynotation

**Represents:** Agency-defined notation/status labels applied to Customers or Policies/Submissions — a simple lookup of custom flags the agency uses. One row per notation definition.

**Contains:** Notation type (Customer vs Policy/Submission), description, permanent/user-defined/deleted flag, and hide-from-UI flag.

**Key relationships:**
- Referenced by `afw_customer.anotid` and `afw_leadlist.custanotid`.
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** Resolving a customer's agency-defined notation/status label (e.g. custom flags shown on the customer record).

---

## afw_claim

**Represents:** A full claim record tracked in AMS360 — more detailed than the summary rows in `afw_custlosshist`. One row per claim.

**Contains:** Linked policy/line of business, cause and date of loss, reporting details (who reported, to whom, report number), claim status and number, closed date, catastrophe code, policy effective/expiration dates at time of claim, loss description, loss location (address/city/state/zip), and additional risk details.

**Key relationships:**
- Referenced by `afw_custlosshist.claimid` when a loss history entry is tied to a full claim record.
- `polid` references `afw_basicpolinfo` (not yet built).
- `lobid` references `afw_lineofbusiness` (not yet built).
- `elfformid` — not backed by a real table (confirmed no `afw_elfformtype` in the ERD), left as a plain UUID.
- `lineofbus` is a lookup code (`afw_PRCode`, AttrCode 'LB'); `causeofloss` looks up against `afw_coverage.coveragecode` (now built — coverage codes vary by policy/LOB, so kept as a plain text lookup rather than a strict FK).
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** Full claim detail lookups, loss run generation, claim status/history by policy. Complements `afw_custlosshist` for underwriting/renewal prep.

---

## afw_agencyxreftype

**Represents:** Agency-defined types of cross-references usable in the customer's X-Reference section (e.g. "CEO"). One row per cross-reference type.

**Contains:** Description, permanent/user-defined/deleted flag, hide-from-UI flag.

**Key relationships:**
- Referenced by `afw_custxref.axrefid` — resolves what kind of cross-reference each `afw_custxref` value is.
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** Labeling cross-reference values on a customer (e.g. "this value is their CEO's name") when joined with `afw_custxref`.

---

## afw_relationshiptype

**Represents:** Setup table defining the kinds of relationships that can link customers together — either Group-style (all Members) or Primary/Secondary-style (Parent/Child) relationships, with agency-configurable role labels. One row per relationship type.

**Contains:** Category (Group vs Primary/Secondary), description, custom labels for the Primary and Secondary roles, and active/inactive status.

**Key relationships:**
- Referenced by `afw_relationship.relationshiptypeid` — resolves the category and role labels for each relationship instance.
- `changedby` is typed `char(3)` in the source spec without an explicit `AFW_Employee.EmpCode` reference (unlike most other tables) — left unenforced, flagged in the pending FK tracker.

**Typical use in MCP queries:** Joined with `afw_relationship` and `afw_customerrelationship` to fully resolve "who is related to this customer, in what kind of relationship, and what's their role" (e.g. "Spouse" vs. "Member").

---

## afw_profilequestion

**Represents:** Setup table defining the profile questions the agency asks customers, scoped to Personal or Commercial lines (or other business types). One row per question.

**Contains:** Question text, expected answer format and length, required/suggested flag, hide-from-UI flag, and applicable business type.

**Key relationships:**
- Referenced by `afw_profileanswer.questionid` — resolves the actual question text for each stored answer.
- `changedby` references `afw_employee.empcode`.
- `typeofbus` is a lookup code (`afw_PRCode`, AttrCode 'TB').

**Typical use in MCP queries:** Joined with `afw_profileanswer` to answer "what did this customer say when asked X" with the question text included.

---

## afw_image

**Represents:** Binary image/document storage used throughout AMS360 — attachments on Activities/Notes/Vendor Invoices, signatures, logos, form letters, schedules, and proposal documents. One row per stored image/document.

**Contains:** The binary data itself, compression code, image type, and a partition value (purpose not detailed in the source doc — likely used for storage sharding).

**Key relationships:**
- Referenced by `afw_employee.imageid`.
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** Low priority for query tooling — this is binary blob storage, not queryable business data. Worth confirming with the client whether this needs to be synced at all given storage cost (per project notes, full schema sync could run up to ~50GB); may be better to skip or sync selectively.

---

## afw_setup1099

**Represents:** Lookup table defining valid 1099 category/type combinations used for tax reporting on employees, brokers, vendors, and general ledger transactions. One row per valid category/type pair.

**Contains:** Only the composite key (`s1099category`, `s1099type`) — per the AMS360 ERD, no description or other fields were visible for this table (unlike others where full field-level spec text was available). Treat as incomplete until confirmed against real sync data or the full doc section.

**Key relationships:**
- Referenced by `afw_employee.s1099category`/`s1099type` and `afw_broker.s1099category`/`s1099type` (both nullable — FK only enforced when both values are present).
- Also referenced elsewhere in AMS360 by `afw_generalledgertransaction`, `afw_paystatementheader`, `afw_generalledgerfiscalyearend`, `afw_vendor`, and `afw_deletepurgeglt` per the ERD — none of these are built yet.

**Typical use in MCP queries:** Low priority — internal tax/accounting classification, not typically agent-facing query data.

---

## afw_businessunitaccess

**Represents:** Reusable "Business Unit Access" groups that control which GL divisions/branches/departments/groups an employee can see or access — shared across multiple employees. One row per access group.

**Contains:** A name/description (agency-defined; AMS360 gives generic defaults like "Div: (All), Dept: (All)" that agencies are meant to rename meaningfully) and standard change tracking.

**Key relationships:**
- Referenced by `afw_employee.buacsid` — NULL means no business unit visibility/access restriction.
- `changedby` is typed `char(3)` in the source spec without an explicit `AFW_Employee.EmpCode` reference — left unenforced, flagged in the pending FK tracker.

**Typical use in MCP queries:** Low priority for query tooling — this is an access-control/permissions construct, not typically agent-facing business data. Useful mainly if building permission-aware queries later.

---

## afw_generalledgerdivision

**Represents:** Agency-defined GL divisions — the top level of the agency's business unit hierarchy (Division → Branch → Department → Group). One row per division.

**Contains:** Name/short name, active status, hide-from-UI flag, production credit and check signature feature toggles, and division-specific late charge configuration (method, rate, thresholds, minimums, description).

**Key relationships:**
- Referenced by `afw_employee.defaultgldivcode`, `afw_customer.gldivcode`, and `afw_leadlist.gldivcode`.
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** Resolving which agency division a customer or employee is assigned to — useful for multi-division agencies segmenting reporting or access by division.

---

## afw_generalledgerbranch

**Represents:** Agency-defined GL branches — an optional level under Division in the business unit hierarchy (Division → Branch → Department → Group). When enabled, a default branch record exists per division. One row per branch.

**Contains:** Name/short name, active status, hide-from-UI flag, and standard change tracking.

**Key relationships:**
- Referenced by `afw_employee.defaultglbrnchcode`, `afw_customer.glbrnchcode`, and `afw_leadlist.glbrnchcode`.
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** Resolving branch assignment for a customer or employee — only meaningful if the agency has branch tracking enabled.

---

## afw_generalledgerdepartment

**Represents:** Agency-defined GL departments — a level in the business unit hierarchy (Division → Branch → Department → Group). One row per department.

**Contains:** Name/short name, active status, hide-from-UI flag, and standard change tracking.

**Key relationships:**
- Referenced by `afw_employee.defaultgldeptcode`, `afw_customer.gldeptcode`, and `afw_leadlist.gldeptcode`.
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** Resolving department assignment for a customer or employee.

---

## afw_generalledgergroup

**Represents:** Agency-defined GL groups — the lowest/final optional level in the business unit hierarchy (Division → Branch → Department → Group). One row per group.

**Contains:** Name/short name, active status, hide-from-UI flag, and standard change tracking.

**Key relationships:**
- Referenced by `afw_employee.defaultglgrpcode`, `afw_customer.glgrpcode`, and `afw_leadlist.glgrpcode`.
- `changedby` references `afw_employee.empcode`.

**Typical use in MCP queries:** Resolving group assignment for a customer or employee — completes the full GL hierarchy chain alongside division/branch/department.

---

---

## Policy Table Group

Building starts here — General Tables (AMS360 doc section 4.3.3), the policy-domain equivalent of the customer table group. The ~190 Policy History tables (section 4.4.3, per-ACORD-form line-item detail like vehicles, buildings, boats) are intentionally deferred; see decision log below.

## afw_basicpolinfo

**Represents:** The core/parent record for every policy term — policy, submission, or an accounting-only row generated from processing a direct bill statement. One row per policy term; `polid` uniquely identifies the row and all its children (same structural role as `afw_customer` for the customer domain).

**Contains:** Policy number, type of business/policy, carrier (company/writing company/underwriter), producer/CSR/broker assignment, effective/expiration dates, continuous-policy flag, renewal reporting settings, multi-entity billing responsibility, GL assignment, billing method/payment plan, audit settings, negotiated commission terms, renewal chain tracking (prior policy/source policy), and various feature-enablement flags (production credit, reinsurance).

**Key relationships:**
- `custid` (FK) ties the policy to `afw_customer`.
- `execcode`, `csrcode`, `changedby` reference `afw_employee.empcode` (enforced).
- `brokercode` references `afw_broker.brokercode` (enforced).
- `anotid` references `afw_agencynotation.anotid` (enforced).
- `gldivcode`/`gldeptcode`/`glbrnchcode`/`glgrpcode` reference the four GL tables (enforced).
- `sourcepolid` and `priorpolid` self-reference `afw_basicpolinfo.polid` for renewal chain tracking.
- `cocode`/`writingcocode` reference `afw_company.cocode` (enforced), `underwriter` references `afw_underwriter` (not yet built), `paypid` references `afw_paymentplan.paypid` (enforced), `masteragent` references `afw_masteragent` (not yet built), `ticomid` references `afw_defaulttieredcommission` (not yet built), `istid` references `afw_invoicesplittemplate` (not yet built).
- Referenced by `afw_claim.polid` (now enforced — was deferred pending this table).

**Typical use in MCP queries:** The anchor for `policy_query` — nearly every policy question starts here: active/expiring policies, policy status, renewal tracking, producer/CSR book of business by policy.

---

## afw_policytransaction

**Represents:** Every transaction (endorsement, new business, renewal, cancellation, etc.) that has occurred on a policy term. At least one row per `afw_basicpolinfo` row — the transaction with `effdate` = the policy's `poleffdate`; can be many more for endorsements. One row per transaction.

**Contains:** Transaction type and description, source (Conversion/Download/Data Entry/AL3/Third Party), non-premium billed, billing method and installment day for this specific transaction, payment plan, cancellation reason, binder replacement tracking, premium on effective date, GL posted flag, and annualized premium/estimated revenue.

**Key relationships:**
- `polid` (FK) ties each transaction to its parent `afw_basicpolinfo` row.
- Composite PK is `(polid, effdate)` — per the AMS360 spec, `effdate` combines the calendar date with a time-of-day increment to keep same-day transactions unique.
- `changedby` references `afw_employee.empcode` (enforced).
- `paypid` references `afw_paymentplan.paypid` (enforced).
- `binderreplacepolteffdate` conceptually points to another row's `effdate` within the same policy (a self-referencing composite relationship) — not FK-enforced given the composite key complexity; flagged for confirmation once real sync data is available.

**Typical use in MCP queries:** Transaction history/audit trail for a policy — "what changed on this policy and when," endorsement tracking, premium changes over the policy term. Complements `afw_basicpolinfo` for the `policy_query` MCP tool.

---

## afw_lineofbusiness

**Represents:** Each application/line of business attached to a policy transaction — e.g. a commercial policy might have both a General Liability application and a Commercial Auto application, each a separate LOB row. Zero to many rows per `afw_policytransaction`; the LOB table is the parent to the individual policy application detail tables (the ~190 deferred Policy History tables). One row per line of business on a policy.

**Contains:** Effective/expiration dates for the LOB itself, the LOB code, plan type, state plan type, writing company, description, sort order, ACORD form/version reference, and the date the application was first actually opened (`appcreateddate`) vs. just created.

**Key relationships:**
- `polid` (FK) ties the LOB to `afw_basicpolinfo`.
- Composite PK is `(polid, lobid)` per spec, but `lobid` alone is also given a unique constraint here (it's a GUID, practically unique on its own) so `afw_claim.lobid` can reference it directly.
- `lineofbus` references `afw_lobsetup.namelobs` (enforced).
- `changedby` references `afw_employee.empcode` (enforced).
- `plantype` references `afw_plansetup` (not yet built), `writingcocode` references `afw_company.cocode` (enforced), `elfformverid` references `afw_elfformversion` (not yet built).
- Referenced by `afw_claim.lobid` (now enforced — was deferred pending this table).

**Typical use in MCP queries:** Resolving what lines of business/applications exist on a policy — essential for any query that needs to break a policy down by coverage type (e.g. "what LOBs does this commercial account have").

---

## afw_address

**Represents:** Generic, reusable address storage — used for entities that can have multiple addresses (originally brokers and vendors). One row per address.

**Contains:** Address lines, city/state/zip/country, and flags for default-on-checks, default-on-forms, primary, and payee-visible. Soft-delete via `status`.

**Key relationships:**
- Polymorphic design: `attachid` + `attachtype` together identify which entity the address belongs to. `attachtype` is FK-enforced against `afw_logicaltable.ltblkey`, but that table's contents are incomplete (see its entry) — so the code-to-table mapping isn't yet resolvable.
- `changedby` references `afw_employee.empcode` (enforced).

**Typical use in MCP queries:** Resolving additional/alternate addresses for brokers or vendors beyond their primary record — low priority unless a specific broker/vendor address question comes up, since `afw_logicaltable`'s contents are still incomplete.

---

## afw_polcontact

**Represents:** Contacts associated with a specific policy/line of business — can pull from an existing `afw_custcontact` or be user-entered directly. One row per policy contact per transaction (tracked historically, same effective-dating pattern as `afw_policytransaction`).

**Contains:** Contact name, responsibility (e.g. Accountant, Claims), full contact details (address, phone numbers across residence/business/fax/mobile/pager, email), title, salutations, preferred contact method, and notes.

**Key relationships:**
- `polid` (FK) ties the contact to `afw_basicpolinfo`; `lobid` (FK) ties it to `afw_lineofbusiness`.
- Composite PK is `(polid, lobid, polcid, effdate)` per spec.
- `attachid`/`attachtype` are a polymorphic pair (same pattern as `afw_address`) — `attachtype` is FK-enforced against `afw_logicaltable.ltblkey`, but that table's contents are incomplete.
- `changedby` references `afw_employee.empcode` (enforced).

**Typical use in MCP queries:** "Who are the contacts on this policy" — useful for commercial accounts with multiple contacts per LOB (e.g. claims contact vs. accounting contact).

---

## afw_policypersonnel

**Represents:** Every employee listed on a policy — producers, reps, sales center reps, and brokers — along with their commission split arrangement. One row per employee-role assignment on a policy.

**Contains:** Employee assignment type (Producer/Exec, Rep, Sales Center Rep, Broker), primary service team flag, commission method and rate (percentage or flat, separately for regular commission and fee commission), negotiated commission scope, production credit split percentage, and template-derived position ranking (Primary Exec, Primary Rep, additional personnel) when a commission template is applied.

**Key relationships:**
- `polid` (FK) ties the assignment to `afw_basicpolinfo`.
- `empcode` and `changedby` reference `afw_employee.empcode` (enforced).
- Composite PK is `(polid, polpid, emptype)` per spec.

**Typical use in MCP queries:** "Who's assigned to this policy and what's their commission split" — directly answers the same kind of service-team question `afw_custaddpersonnel` answers at the customer level, but at the policy level with commission detail.

---

## afw_policypersonnelperiods

**Represents:** Historical tracking of when an employee was added to or removed from a policy — the audit trail behind the current-state assignments in `afw_policypersonnel`. One row per assignment period.

**Contains:** Employee and role type, active flag, start/end dates for the period.

**Key relationships:**
- `polid` (FK) ties the period to `afw_basicpolinfo`.
- `empcode` and `changedby` reference `afw_employee.empcode` (enforced).
- No dedicated row ID given in the AMS360 spec — PK assumed as composite `(polid, empcode, emptype, startdate)` since an employee can have multiple periods on the same policy over time.

**Typical use in MCP queries:** "When did this producer take over the account" or historical service-team changes on a policy — complements `afw_policypersonnel`'s current-state view.

---

## afw_submission

**Represents:** Links a submission (a policy in `PolSubType='S'` state per `afw_basicpolinfo`) to its submission group — used when quoting the same risk to multiple carriers simultaneously. One row per submission-to-policy link.

**Contains:** Just the linking IDs and standard change tracking — this is a thin association table.

**Key relationships:**
- `polid` (FK) ties the submission to `afw_basicpolinfo`.
- `subgrid` references `afw_submissiongroup` (not yet built — groups multiple submissions together, e.g. one group per prospect being quoted across several carriers).
- `changedby` references `afw_employee.empcode` (enforced).

**Typical use in MCP queries:** Low priority standalone — mainly useful once `afw_submissiongroup` exists, to answer "what other carriers were quoted alongside this submission."

---

## afw_submissiongroup

**Represents:** A group of submissions created together for the same prospect/customer — used when quoting the same risk to multiple carriers simultaneously (each carrier quote becomes a separate `afw_submission` row linked back to this group). One row per submission group.

**Contains:** Group number, group creation date, and standard change tracking.

**Key relationships:**
- `custid` (FK) ties the submission group to `afw_customer`.
- Referenced by `afw_submission.subgrid` (now enforced — was deferred pending this table).
- `changedby` references `afw_employee.empcode` (enforced).

**Typical use in MCP queries:** "What carriers were this prospect quoted with together" — joined with `afw_submission` and `afw_basicpolinfo` to see all submissions in the same group.

---

## afw_commissiontemplate

**Represents:** Reusable commission split templates that can be applied to a policy — referenced by `afw_policypersonnel.position` when a template drives the personnel commission structure. One row per template.

**Contains:** Template name, optional GL scoping (division/branch/department/group), active and default flags.

**Key relationships:**
- `gldivcode`/`glbrnchcode`/`gldeptcode`/`glgrpcode` reference the four GL tables (enforced).
- `changedby`/`enteredby` reference `afw_employee.empcode` (enforced).
- Conceptually linked to `afw_policypersonnel` (via the template's effect on `position`) and to `afw_commissiontemplatepersonnel` (now built — defines the template's personnel/split structure).

**Typical use in MCP queries:** Explaining a policy's commission structure when a template is applied — join with `afw_commissiontemplatepersonnel` for the actual split detail.

---

## afw_commissiontemplatepersonnel

**Represents:** The personnel/split structure defined within a commission template — one row per employee-role slot per renewal term within a template. This is what actually gets copied onto `afw_policypersonnel.position` when a template is applied to a policy.

**Contains:** Template term (renewal count), employee role type, primary flag, position ranking, commission method/rate for both regular commission and fees, and negotiated commission scope.

**Key relationships:**
- `commissiontemplateid` (FK) ties each personnel slot to its parent `afw_commissiontemplate`.
- `changedby`/`enteredby` reference `afw_employee.empcode` (enforced).
- Not directly linked to specific employees — this defines role *slots* (Primary Exec, Primary Rep, etc.), which get filled with actual `afw_employee` rows only once applied to a policy via `afw_policypersonnel`.

**Typical use in MCP queries:** Explaining a policy's commission structure when a template is applied — "why does this policy split commission this way." Completes the `afw_commissiontemplate` dependency.

---

## afw_externalentity

**Represents:** Cross-reference linking AMS360 entities (like customers) to their corresponding records in external Vertafore-integrated applications (AgencyZoom, BenefitPoint, Commercial Submissions, ImageRight, PL Rating). One row per external-system link.

**Contains:** Which external app, that app's tenant location, the external system's key for the entity, and (polymorphically) which AMS360 entity it maps to.

**Key relationships:**
- Polymorphic design: `entitytype` + `amskey` together identify which AMS360 entity is linked, same pattern as `afw_address`/`afw_polcontact` — `entitytype` is FK-enforced against `afw_logicaltable.ltblkey`, but that table's contents are incomplete.
- `changedby`/`enteredby` reference `afw_employee.empcode` (enforced).

**Typical use in MCP queries:** Potentially valuable if the agency uses AgencyZoom or BenefitPoint alongside AMS360 — "what's this customer's ID in [external system]." Low priority unless one of those integrations is confirmed in use.

---

## afw_fieldimportance

**Represents:** UI/setup configuration defining which fields are Required, Recommended, Optional, or System-level on each AMS360 data entry page. Not transactional business data — this is agency configuration for the AMS360 interface itself.

**Contains:** View code (which AMS360 page), field description, and the configured importance level.

**Key relationships:**
- `changedby`/`enteredby` reference `afw_employee.empcode` — both nullable per spec, unlike most other tables (enforced where present).

**Typical use in MCP queries:** Very low priority — this configures AMS360's own UI, not agency/customer data. Skip unless a specific need arises for understanding field requirements programmatically.

---

## afw_phonenumber

**Represents:** International phone numbers, tracked separately from the legacy area-code/phone/extension fields scattered across other tables (like `afw_customer`, `afw_custcontact`) since those don't handle non-US formats well. One row per phone number.

**Contains:** Phone type (Business/Cell/Fax/Pager/Residence/Other), country dialing code, the number itself, extension, display order, and active/deleted status.

**Key relationships:**
- Polymorphic design (same pattern as `afw_address`): `attachtype` + `attachid` identify which entity the phone number belongs to. `attachtype` is FK-enforced against `afw_logicaltable.ltblkey`, but that table's contents are incomplete.
- `changedby` references `afw_employee.empcode` (enforced).

**Typical use in MCP queries:** Low-to-moderate priority — mainly relevant for international customers/contacts where the standard phone fields fall short. Resolving which entity each row belongs to depends on `afw_logicaltable`'s contents being filled in.

---

## afw_policyattribute

**Represents:** Generic key/value attribute data attached to a policy — same EAV pattern as `afw_customerattribute`, but at the policy level. One row per attribute value assigned to a policy.

**Contains:** Which policy, which attribute type, and the value (stored as text).

**Key relationships:**
- `polid` (FK) ties the attribute to `afw_basicpolinfo`.
- `policyattributetypeid` references `afw_policyattributetype` (not yet built — same relationship as `afw_customerattribute` → `afw_customerattributetype`).
- `changedby`/`enteredby` reference `afw_employee.empcode` (enforced).

**Typical use in MCP queries:** Join with `afw_policyattributetype` (now built) to resolve attribute name/data type — answers "what custom attributes does this policy have."

---

## afw_policyattributetype

**Represents:** Lookup/definition table for the attribute types referenced by `afw_policyattribute` — same relationship as `afw_customerattributetype` to `afw_customerattribute`. One row per distinct custom policy attribute the agency has defined.

**Contains:** Attribute name (label) and its data type (how the raw value in `afw_policyattribute.policyattributevalue` should be interpreted).

**Key relationships:**
- Referenced by `afw_policyattribute.policyattributetypeid` (now enforced).
- `changedby`/`enteredby` reference `afw_employee.empcode` (enforced).

**Typical use in MCP queries:** Joined with `afw_policyattribute` to resolve attribute names/types — answers "what custom attributes does this policy have."

---

## afw_policychklstdetail

**Represents:** Historical/migrated checklist step data from legacy AFW checklists, used for AMS360's Checklist Report. **AMS360 no longer writes to this table** — it's purely historical, migrated data. One row per checklist step.

**Contains:** Step number/type (Policy Memo, Binder, Form Letter, Custom, etc.), days-to-complete target, description, target date, closed date (system-tracked vs. user-entered), who closed it, and N/A reason if applicable.

**Key relationships:**
- `polchid` (FK, composite PK with `stepno`) ties each step to its parent `afw_policychklstheader` (now enforced).
- `closedbyempcode` references `afw_employee.empcode` (enforced) — required when the step is closed.
- `changedby` is **not** FK-enforced: per the spec, migrated rows carry a sentinel value (`'^^^'`) rather than a real employee code.

**Typical use in MCP queries:** Low priority — purely historical data from a legacy system, not reflective of current agency workflow. Worth confirming with the client whether this has any ongoing relevance before prioritizing.

---

## afw_policychklstheader

**Represents:** Historical/migrated checklist headers from legacy AFW checklists — the parent record for `afw_policychklstdetail` steps. **AMS360 no longer writes to this table**, same as its detail table. One row per checklist instance applied to a policy transaction.

**Contains:** Checklist name, assigned employee, completion flag, and date initiated.

**Key relationships:**
- `polid` (FK) ties the checklist to `afw_basicpolinfo`.
- `empcode` references `afw_employee.empcode` (enforced) — who the checklist is assigned to.
- `changedby` is **not** FK-enforced — sentinel `'^^^'` for migrated rows, same as `afw_policychklstdetail`.
- Parent to `afw_policychklstdetail.polchid` (now enforced).

**Typical use in MCP queries:** Low priority — same caveat as `afw_policychklstdetail`: purely historical/legacy data, not reflective of current workflow.

---

## afw_policysubcustomer

**Represents:** Links a policy to the various customers involved when it's written for a Multi-Entity (master/sub-customer) setup — see `afw_customer.mastersubtype`. One row per customer-to-policy link on a multi-entity policy.

**Contains:** Just the linking IDs, status, and standard change tracking — a thin association table (same pattern as `afw_submission`).

**Key relationships:**
- `polid` (FK) ties the record to `afw_basicpolinfo`; `custid` (FK) ties it to `afw_customer`.
- Composite PK is `(custid, polid, polscid, effdate)` per spec.
- `changedby` references `afw_employee.empcode` (enforced).

**Typical use in MCP queries:** "Which customers/entities are covered under this multi-entity policy" — relevant for commercial accounts with related legal entities sharing a policy.

---

## afw_policytranpremium

**Represents:** Premium detail broken out by line of business, plan, and writing company for each policy transaction. Zero to many rows per `afw_policytransaction` — on an endorsement, one row per unique LOB/plan/company/billing-method combination carries forward from prior transactions. Three row types: standard billable, "do not bill," and company-correction (memo/audit) rows.

**Contains:** LOB, plan type, writing company, premium (user-entered, billed, written, full-term), billing method, whether to include in premium totals, correction/posted/suspended flags, charge category/code, non-premium recipient, company/company-type, direct-bill-statement reconciliation status, estimated revenue, and annualized premium/revenue.

**Key relationships:**
- `(polid, effdate)` FK ties each row to its parent `afw_policytransaction`.
- Composite PK is `(polid, effdate, poltpid)` per spec; `poltpid` is the FK target for this table's child table `afw_policycompanypremium` (not yet built).
- `lineofbus` references `afw_lobsetup.namelobs` (enforced).
- `changedby` references `afw_employee.empcode` (enforced).
- `plantype` references `afw_plansetup` (not yet built); `writingcocode`/`cocodepoltp` reference `afw_company.cocode` (enforced); `chargecodepoltp` references `afw_setupbillingtran` (not yet built); `ticomid` references `afw_defaulttieredcommission` (not yet built).

**Typical use in MCP queries:** Premium breakdown by line of business on a policy — "what's the premium for the auto vs. GL portion of this account," billing method per LOB, revenue estimates.

---

## afw_coverage

**Represents:** Personal Lines coverages, limits, deductibles, and premiums on a policy — technically part of AMS360's Policy History table group (section 4.4.3, mostly deferred), but built now since `afw_claim.causeofloss` depends on it. One row per coverage on a policy/LOB/transaction.

**Contains:** Coverage code and description, up to three limits and deductibles (with deductible types), full-term premium, net change amount, coinsurance percentage, form number/date, statutory flag, and parent-coverage linkage for coverages attached to other coverages (e.g. endorsements to a base coverage).

**Key relationships:**
- `polid` (FK) ties the coverage to `afw_basicpolinfo`; `lobid` (FK) ties it to `afw_lineofbusiness`.
- Composite PK is `(polid, lobid, coverageid, effdate)` per spec.
- Polymorphic `attachid`/`attachtype` pair (same pattern as `afw_address`/`afw_polcontact`) — `attachtype` is FK-enforced against `afw_logicaltable.ltblkey`, but that table's contents are incomplete.
- `parentcovid` conceptually self-references this table (for attached/endorsement coverages) but isn't FK-enforced given the composite PK.
- `changedby` references `afw_employee.empcode` (enforced).
- Referenced conceptually by `afw_claim.causeofloss` (a coverage code lookup, not a strict FK — coverage codes vary by policy/LOB, so left as a plain text lookup rather than enforced).

**Typical use in MCP queries:** Coverage detail on a policy — limits, deductibles, premium by coverage. Useful for underwriting/coverage review questions once the deferred Policy History tables aren't needed for other coverage detail.

---

## afw_company

**Represents:** Every company the agency does business with — Insurance carriers, Finance companies, Brokerages, Fee companies, and Writing companies (sub-companies under a parent carrier). One row per company.

**Contains:** Name/short name, company type, NAIC code, A.M. Best rating, download/FTP configuration (host, account, **password — sensitive**), file compression settings, direct bill statement auto-match settings, and parent company linkage for writing companies.

**Key relationships:**
- `coid` is the PK; `cocode` is a unique alternate key and is what `afw_basicpolinfo.cocode`/`writingcocode`, `afw_lineofbusiness.writingcocode`, and `afw_policytranpremium.writingcocode`/`cocodepoltp` all actually reference (all now enforced).
- `parentcocode` self-references `afw_company.cocode` — writing companies point back to their parent carrier.
- `changedby` references `afw_employee.empcode` (enforced).

**⚠️ Sensitive data:** `ftppassword` and `encryptpassword` are download credentials. Recommend excluding these columns from the MCP server's general query tool, or restricting to admin-only access.

**Typical use in MCP queries:** Resolving which carrier a policy is written with — "what carrier is this policy," carrier ratings, brokerage vs. direct-carrier distinction.

---

## afw_logicaltable

**Represents:** A lookup that maps numeric type codes to the actual AMS360 tables they identify — the resolution mechanism for every polymorphic `attachtype`/`entitytype` column in the schema. **Incomplete:** no field-level spec section was found for this table despite being referenced repeatedly across the ERD; only the key field name (`LTblKey`) is confirmed. Treat as a placeholder until real sync data or the actual doc section surfaces — same situation as `afw_setup1099`.

**Contains:** Only the key column for now. Presumably also has a name/description field identifying which table each key maps to, but that's unconfirmed.

**Key relationships:**
- Referenced by `attachtype` on `afw_address`, `afw_polcontact`, `afw_phonenumber`, `afw_coverage`, and `entitytype` on `afw_externalentity` (all now enforced).

**Typical use in MCP queries:** Without the actual code-to-table mapping, this table can't yet resolve what `attachtype`/`entitytype` values mean in practice — flag to Patrick or pull from the live AMS360 database's `AFW_LogicalTable` table directly if the doc section can't be located.

---

## afw_paymentplan

**Represents:** Payment/installment plans used by the billing system — can be customized per company to automate billing fee application. One row per payment plan.

**Contains:** ACORD standard code, description, plan type ('C' for Company), hide-from-UI flag, and permanent/user-added/user-deleted flag.

**Key relationships:**
- Referenced by `afw_basicpolinfo.paypid` and `afw_policytransaction.paypid` (both now enforced).
- `changedby` references `afw_employee.empcode` (enforced).

**Typical use in MCP queries:** Resolving what payment/installment plan applies to a policy or transaction — useful for billing-related questions ("how is this policy billed," installment schedules).

---

---

## Invoice Table Group

Building starts here — the billing/AR domain (AMS360 doc section 6.3), completing the original Phase 1 `invoice_lookup` MCP tool scope alongside `customer_lookup` and `policy_query`.

## afw_invoice

**Represents:** A billing invoice — the header record grouping together billing transaction lines under a single invoice number. Can originate from policy billing, cash receipts, journal entries, or checks posting to AR (On Account invoices). One row per invoice.

**Contains:** Invoice type, effective/invoice/due dates, invoice number, billing method (Agency vs. Direct Bill), policy relation (policy-specific vs. customer-level), GL assignment, broker/producer/rep attribution, installment/cancellation/binder-billing flags, closed and AR-closed status tracking, and void/original invoice linkage for corrections.

**Key relationships:**
- `custid` (FK) ties the invoice to `afw_customer`; `polid` (FK) ties it to `afw_basicpolinfo` — both nullable since not every invoice is policy-related (see `polrelation`).
- `gldivcode`/`gldeptcode`/`glbrnchcode`/`glgrpcode` reference the four GL tables (enforced).
- `brokercode` references `afw_broker.brokercode` (enforced).
- `execcode`/`repcode`/`changedby` reference `afw_employee.empcode` (enforced).
- `originalinvidinv`/`voidinvidinv` self-reference `afw_invoice.invid` for void/correction tracking.
- `collectionid` references `afw_invoicecollection` (not yet built), `bhid` references `afw_billingheader` (not yet built), `invtype` references `afw_constant` (not yet built, a general constants/enum table).

**Typical use in MCP queries:** The anchor for `invoice_lookup` — outstanding balances, invoice history for a customer or policy, billing method breakdown, void/correction tracking.

---

## afw_transaction

**Represents:** A chronological, immutable activity log of customer communications, submission activity/responses, and policy memos — despite the name, this is **not** a billing/financial transaction table (that's `afw_policytranpremium`/`afw_invoice` territory). Once written, AMS360 does not allow updates. One row per logged activity.

**Contains:** Action description, transaction date, comment, and — when linked to a policy — a snapshot of policy data at the time (policy number, LOB, dates, exec/CSR, premium) captured from `afw_basicpolinfo`/`afw_policytransaction` at insert time. Submission responses additionally carry the responding carrier via `cocode`.

**Key relationships:**
- Polymorphic `entityid`/`entitytype` pair: identifies which "center" (Bank, Broker, Company, Customer, Employee, User, Vendor) the activity is attached to — activities aren't limited to customers. `entitytype` is a lookup (`afw_PRCode`, AttrCode 'CEN'); `entityid` itself isn't a normal single-table FK since it varies by type.
- `polid` (FK) optionally ties the activity to `afw_basicpolinfo`; `cocode` (FK) optionally ties it to `afw_company`.
- `empcode`/`execcode`/`csrcode`/`changedby` reference `afw_employee.empcode` (enforced).
- Second polymorphic pair `refid`/`reftype`: links the activity to another item beyond the policy (e.g. a policy memo, via `reftype` = `afw_logicaltable.ltblkey`, now enforced — though `afw_logicaltable`'s own contents are still incomplete).
- `refgrid` references `afw_refgroup.refgrid` (now enforced).

**Typical use in MCP queries:** The anchor for activity/communication history — "what's the recent activity on this customer/policy," submission tracking, audit trail of agency-customer interactions. Note `entityid` isn't limited to customers, so filtering needs to account for `entitytype`.

---

## afw_refgroup

**Represents:** Setup table for named groups that activities/transactions can be tagged with — a way to categorize or bucket related `afw_transaction` rows together beyond just their policy/entity attachment. One row per group.

**Contains:** Group name, active flag, group type (category/sorting code), and the entity (customer, bank, broker, employee, or vendor) the group belongs to.

**Key relationships:**
- Polymorphic `entityid`/`entitytype` pair (same pattern as `afw_transaction`'s primary attachment) — `entitytype` is a lookup (`afw_PRCode`, AttrCode 'CEN').
- Referenced by `afw_transaction.refgrid` (now enforced).
- `changedby` references `afw_employee.empcode` (enforced).

**Typical use in MCP queries:** Grouping/filtering activity history by a named category — lower priority than `afw_transaction` itself, but completes that table's dependency.

---

<!-- Add new table entries below as they're built. Keep format consistent: Represents / Contains / Key relationships / Typical use. -->
