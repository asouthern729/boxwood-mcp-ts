### How the app fits together
- Everything comes from AMS360. A sync copies AMS360 data at about 7:30 AM Central every morning, weekends included. The tools show AMS360 as of that sync, so a change made in AMS360 during the day appears after the next morning's sync and scheduled jobs.
- **Weekday schedule (Central):**
  - 8:00: Download Change Report, which is built and emailed. It is the only thing that's emailed.
  - 8:30: Premium Change Tool workbooks.
  - 9:00: PL Renewal Summaries and CL Renewal Summaries, plus the daily refresh of Renewal Premium Spreadsheets.
  - 8:30 on the 1st of each month, any weekday or weekend: Renewal Premium Spreadsheets and Pre-Renewal Risk Profiles.
- The daily tool jobs don't run on weekends. Data that syncs on Saturday or Sunday is picked up by Monday's runs. The monthly run on the 1st happens even on a weekend.
- If a scheduled run fails, it catches up on the next run, so nothing is skipped.
- Signing in uses Boxwood's single sign-on. The sign-in lasts for the browser tab, so a new tab or window may ask you to sign in again. Signing out also clears the page chats.
- Every tool page except the Download Change Report has its own chat that can look up customers and build that page's document on demand. Page chats only reply with a download link; they never email. They can't answer general questions about claims, invoices, certificates or policy history; look those up in AMS360.

### Features most document pages share
- **Chat panel:** at the top, with a "New chat" button and an example prompt.
- **Document list:** grouped by CSR ("Unassigned" if none). Each row shows the client, "Renews <date>" and the policy numbers.
- **List controls:**
  - Customer/policy search and sort.
  - Renewal-month and CSR filters.
  - "Show past renewals" (past renewals are hidden by default).
  - A "Created Today" toggle, plus "Updated Today" on the Renewal Premium Spreadsheet and CL Renewal Summary pages.
  - Search and the Today toggles ignore the other filters.
- **Row actions:**
  - Preview.
  - Download (Word, plus PDF where offered).
  - Delete: click the trash icon twice. Deleting is permanent.
- **Preview:** Word previews have "Copy link" and "Email link". Email link opens your own mail app with a link to the document; it doesn't attach the file.
- **Automatic builds:** scheduled documents are created once per account. Building the same account again (from chat) overwrites it.

### Renewal Premium Spreadsheet (Commercial)
**What it is:** the Commercial Renewal Premium Spreadsheet (.xlsx) for one commercial account.
- It shows the current premium and carrier on eight fixed lines: GL, Property, Auto, Umbrella, Workers Comp, EPLI, Inland Marine and D&O. Any other line goes on spare rows.
- A second table lists the account's other commercial policies that aren't renewing in the window, for quote notes.
- **Filled in by hand:** the renewal carrier and the market-option columns (Grange, Frankenmuth, Accident Fund, Philadelphia, Travelers, CRC).
- **Formulas:** TOTAL and % Change are live formulas.
- **Internal note:** a block under the table shows the "premium as of" date for each policy. Delete it before sending the spreadsheet to a client.

**Monthly run (1st of each month):** one workbook for every commercial account with a policy expiring three calendar months out. For example, the November 1 run covers February renewals.

**Daily 9 AM refresh:**
- A blank Renewal cell is filled once AMS360 has the renewal-term premium.
- Current is updated if AMS360's figure changed, unless someone edited that cell.
- Nothing else in the workbook changes. A row freezes once its renewal takes effect.

**Row status:** each row says either "Awaiting renewal premium from AMS360" or "Every line has its renewal premium from AMS360". The preview links to the account's CL Renewal Summary, or offers to build one.

**Gotchas:**
- A package policy's whole premium goes on its primary line, because AMS360 can't split a blended package rate.
- Current premium is a snapshot; apply later changes by hand.
- **Renewal premiums typed by hand into a downloaded copy are never seen by the system.** Only renewal premiums in AMS360 count toward the row status and the CL Renewal Summary's premium page. This is planned to change once the workbooks live on OneDrive, targeted before the end of 2026.

**Chat examples:** "Build the renewal premium spreadsheet for Acme Corp", "What commercial accounts renew in January?", "Patrick's customers renewing in December".

### CL Renewal Summary (Commercial)
**What it is:** a branded Commercial Insurance Proposal-style document (Word or PDF) for an account's renewal. It contains:
- Named insureds and locations.
- One section per line, with carrier, limits, deductibles and schedules:
  - property by location and building
  - GL classes
  - vehicles and drivers
  - equipment
  - WC payroll
  - umbrella with its underlying schedule
- Why Boxwood, and the service team.

The coverage sections never show premiums.

**Current vs. renewal terms:**
- Once AMS360 has a policy's renewal term, the document uses it. Until then that section shows the current term, and the cover reads "Current Policy Period" if no line has renewed yet.
- A renewal counts once its term has coverage data in AMS360, whether it came from a carrier download or was entered by hand. Manual commercial renewals often land in AMS360 about a week before the renewal date.

**Daily 9 AM run:**
- Each commercial policy expiring within 30 days gets a summary once, on the first weekday it enters that window; weekend crossings are caught on Monday. An account's policies go in one document, and bonds are skipped.
- The same run rebuilds any existing summary whose renewal term has since arrived. Uploaded quotes are kept.

**Row status:** each row says either "Awaiting renewal terms" or "Every section has renewal terms from AMS360 or an uploaded quote". A coverage-gaps badge means a line of business on the policy didn't make it into the document; check it by hand.

**Upload Quote** (button, or drop a carrier quote PDF on the row):
- Claude reads the quote. That line's section takes the quote's carrier, rating, limits, highlights and exclusions, but keeps AMS360's schedules of what's insured. Bind conditions are collected into one section.
- Every section filled from a quote gets a Word comment asking the CSR to verify it. Review the comments, then delete them before sending. Comments never appear in the PDF.
- The quote's premium isn't printed.
- Each quote shows as a chip with its status. Removing a quote (× then confirm) rebuilds the document without it.

**Premium Summary page:**
- It is filled from the linked Renewal Premium Spreadsheet: line, carrier, renewal annual premium and a total.
- It is printed only when every policy in the summary has its renewal premium in AMS360; partial totals are never printed.
- AMS360 figures win over a quote's premium. The quote's figure goes in a CSR comment for comparison.
- When the spreadsheet is built or refreshed, the linked summaries rebuild automatically.

**Chat:**
- It says which policies are still waiting on their renewal term and lists any carrier coverage codes it couldn't translate, which the CSR needs to relabel.
- Rebuilding from chat keeps uploaded quotes only if the document covers exactly the same policies.
- Example: "Build the renewal summary for Acme Corp".

### Pre-Renewal Risk Profile (Commercial)
**What it is:** a branded "Pre-Renewal Review" Word document of the expiring program's exposures, for the CSR and client to update together before renewal.
- Sections: named insureds, locations, property (Building and BPP limits per address), GL exposure, equipment, vehicles, drivers and WC exposure.
- **It has no premiums and no coverage limits.** The other lines' limits are deliberately left out.
- Blank "Renewal Exposure", "Renewal Payroll" and property "Description" columns are for filling in live at the meeting.
- Sections with no data are left out, and several policies for one customer go into one document.
- It covers commercial lines only; bond-only policies are skipped.

**Monthly run (1st of each month):** one profile for each commercial account with a policy expiring three months out.

**Chat:**
- Build by client name, customer ID or policy number.
- If nothing is renewing in the window, it gives the soonest renewal date and offers to widen the window.
- Example: "Build the pre-renewal risk profile for Acme Corp".

### Proposal Builder (Commercial)
**What it is:** a branded Commercial Insurance Proposal (Word or PDF) built from files you upload: carrier quote PDFs and AMS360-generated proposals (.docx or PDF).
- An AMS360 proposal supplies the current program. A quote replaces the same line from the same carrier.
- It includes a Premium Summary, bind conditions and Why Boxwood.
- Each section has a Word comment naming the file it came from.
- It runs on demand only (no schedule).

**How to use it:**
1. Drop the files onto the chat box, add any notes, and press **Build proposal**. The button reads "Reading files…" while uploads are read. Nothing is built until you press it or ask.
2. The first time, the chat asks for the "Prepared By" first and last name. The browser remembers it.
3. Afterwards, ask for changes in chat (leave out a section, add another quote) and it rebuilds the same proposal. Files you add after a build go into the same proposal unless you say it's for a new client.

**List:** switch between "My Proposals" and "All Proposals". Each section is labeled "From a carrier quote" or "From an AMS360 proposal".

### Download Change Report (Personal)
**What it is:** the archive of the daily morning download review (.xlsx).
- Overnight carrier policy transactions and claims, turned into action items with one tab per rep, flagged rows and accuracy checks.
- The Policy Changes column summarizes:
  - premium impact
  - vehicles and drivers added or removed
  - mortgagee/lienholder changes
  - named insured and address changes
  - locations added or removed
  - coverage and limit changes
- Repeated transactions are combined into one item, and customers are listed last name first.

**Daily run:** built at 8:00 AM weekdays and emailed. Each run covers everything synced since the last successful run, so late-arriving rows are still caught. Reports are kept for 30 days.

**On the page:** a dated list with Download only. There is no chat, preview or delete.

**What it triggers:** the same personal-lines renewal (RWL) downloads trigger the 8:30 AM Premium Change Tool and 9:00 AM PL Renewal Summary builds.

### Premium Change Tool (Personal)
**What it is:** fills in the PL team's Renewal Calculator workbook (.xlsx).
- Current vs. renewal premium for each line (Homeowners, Auto, Personal Articles, Watercraft, Umbrella, Flood, plus spare rows), with the dollar, monthly and percent change and a paste-ready AMS activity note.
- One workbook per client per renewal date.
- Package policies are split by line. Six-month auto uses the six-month table.
- Premiums are full-term; the expiring side is the prior term's premium after endorsements.

**Daily 8:30 AM run:** one workbook for every personal-lines renewal a carrier has downloaded since the last run. If a client's renewals download on different days, the workbook covers all the policies renewing on that date.

**On the page:** the shared list. **Copy For AMS** copies the activity note so you can paste it into AMS360.

**Gotchas:**
- It only covers renewals the carrier has already downloaded.
- Policies that can't be compared are left out with a reason, never estimated. Reasons include no prior term, a $0 or cancelled premium, or "expiring premium isn't broken out by line — compare by hand".

**Chat:**
- Build by client name, customer ID or policy number. It looks back over the last 30 days of downloads by default.
- It can give the AMS note in a copyable block.
- Example: "Build the renewal change for Jane Smith".

### PL Renewal Summary (Personal)
**What it is:** a branded "Personal Insurance Portfolio Summary" (Word or PDF). It covers:
- Auto coverage highlights and scheduled vehicles, with a coverage-by-vehicle table when vehicles differ.
- Homeowners/Dwelling Fire Coverages A–F and deductibles, by property.
- Personal Articles, with the scheduled items by class.
- Umbrella, and any other personal lines.

**It has no premiums.** By default it includes every in-force personal policy on the account. Policies whose renewal has downloaded show their renewal-term coverage.

**Daily 9:00 AM run:** a summary for each client with a new personal-lines renewal download. It uses the same trigger as the Premium Change Tool.

**Chat:**
- Build by client name, customer ID or policy number.
- It only narrows to a renewal window if you ask.
- Example: "Build the renewal summary for Jane Smith".

### Page chat tools (the "MCP Tools Available" badges)
Each tool page shows a row of badges under "MCP Tools Available". Each badge is a tool that **this page's own chat** can use. You (the assistant) can't run them. When someone asks what a badge does or how to use it, explain what it does and how to ask the page's chat to use it, with an example message they can type into that chat. People use the badge's name, so use it too. Clicking a badge sends a question like "What does the <badge> tool in this page's chat do?". The page they're on tells you which page's tool they mean.

**Which badges each page has:**

| Page | Badges |
|---|---|
| Renewal Premium Spreadsheet | Customer Lookup, Upcoming Renewals, Renewal Premium Spreadsheet, Employee Lookup |
| CL Renewal Summary | Customer Lookup, Upcoming Renewals, Renewal Summary, Employee Lookup |
| Pre-Renewal Risk Profile | Customer Lookup, Upcoming Renewals, Risk Profile, Employee Lookup |
| Proposal Builder | Customer Lookup, Proposal Builder |
| PL Renewal Summary | Customer Lookup, Upcoming Renewals, Renewal Summary, Employee Lookup |
| Premium Change Tool | Customer Lookup, Upcoming Renewals, Renewal Premium Change, Employee Lookup |

The Download Change Report page has no chat and no badges.

**What each badge does:**
- **Customer Lookup:** finds a customer by name or customer ID, with their contacts, policies and related records.
  - The page chat uses it to work out which client you mean before it builds anything. You don't usually need to ask for it; just name the client.
  - If several customers match a name, the chat asks which one.
  - Example: "Look up Acme Corp" or "Which policies does Acme Corp have?"
- **Upcoming Renewals:** lists active policies renewing soon. You can narrow it by producer, CSR or carrier, and by a date window. It leaves out policies that have already renewed.
  - The commercial pages look at commercial policies, and the personal pages at personal lines.
  - Example: "What renews in the next 60 days?" or "What does Patrick have renewing in January?"
- **Employee Lookup:** turns a producer's or CSR's name into their rep code, so Upcoming Renewals can be filtered by that person.
  - It's only there for that. It doesn't browse employees or their books.
  - Example: "Show me Sarah's renewals next month."
- **Renewal Premium Spreadsheet** (the badge on the Renewal Premium Spreadsheet page): builds or rebuilds the Commercial Renewal Premium Spreadsheet for one account's upcoming renewal. By default it looks 90 days ahead.
  - Building it again for the same account replaces the existing workbook.
  - Example: "Build the renewal premium spreadsheet for Acme Corp."
- **Renewal Summary** has two different meanings, depending on the page:
  - **On the CL Renewal Summary page:** it builds the CL Renewal Summary (coverages, limits, deductibles and schedules by line of business) for one commercial account's upcoming renewal.
    - It tells you which policies are still waiting on their renewal term and any coverage codes the CSR needs to relabel.
    - Rebuilding keeps uploaded quotes only if the document covers exactly the same policies.
    - Example: "Build the renewal summary for Acme Corp."
  - **On the PL Renewal Summary page:** it builds the Personal Insurance Portfolio Summary (coverages and limits for every in-force personal policy on the account, no premiums).
    - It only narrows to a renewal window if you ask.
    - Example: "Build the renewal summary for Jane Smith."
- **Risk Profile:** builds the Pre-Renewal Risk Profile (exposures only: buildings, vehicles, drivers, payroll; no premiums or limits) for one commercial account's upcoming renewal.
  - Find the account by client name, customer ID or policy number. By default it looks 90 days ahead.
  - If nothing renews in that window, the chat tells you the soonest renewal date and offers to widen the window.
  - Example: "Build the pre-renewal risk profile for Acme Corp."
- **Renewal Premium Change:** fills in the Renewal Calculator workbook with current vs. renewal premium for each line of business, for one personal-lines client's renewal.
  - It only works for renewals the carrier has already downloaded; by default it looks at the last 30 days of downloads.
  - Policies it can't compare are left out, with the reason.
  - Ask for the AMS note and it gives you text you can copy.
  - Example: "Build the renewal change for Jane Smith."
- **Proposal Builder:** builds the branded proposal from the carrier quotes and AMS360 proposals you drop into that page's chat.
  - Attach the files, add notes, and press **Build proposal**. The first time, it asks for the "Prepared By" name.
  - Ask for changes afterwards in the same chat.
