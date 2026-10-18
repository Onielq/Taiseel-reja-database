# Dubai REST reference and Rwanda adaptation plan

**Status:** Product architecture note for the DXB Interact-inspired Market Intelligence work  
**Reference reviewed:** Dubai Land Department's official Dubai REST service page and official FAQ  
**Product boundary:** This document describes a proposed Taiseel roadmap. It does not claim that Taiseel is connected to Rwanda land registries, RDB/RHA, banks, courts, licensed valuers, or payment providers.

## 1. What Dubai REST contributes that a market analytics dashboard does not

Dubai REST is not just a property search or pricing website. Dubai Land Department describes it as a real-estate services platform serving owners, tenants, brokers, developers, valuers, investors and other market participants.

Officially documented capabilities include:

- **Owner property wallet:** a private view of a person's properties, current property-price information, rental return and service charges.
- **Lease lifecycle:** lease registration, renewal and cancellation, along with rental-dispute submission and follow-up.
- **Market indexes:** rental and sale indexes covering different periods, plus service-charge index information.
- **Off-plan monitoring:** project completion percentages, progress images, escrow account information, buyer payments due and project favourites.
- **Professional directories:** broker performance, office classifications, valuation companies, property-management companies, consultancies and certified developers.
- **Property-related services:** requests for property valuation and maps, certain letters and mortgage-related bids, and service-charge payments.

Primary references:
- Dubai Land Department, Dubai REST: https://dubailand.gov.ae/en/eservices/dubai-rest/
- Dubai Land Department, FAQ (escrow and project-progress explanations): https://dubailand.gov.ae/en/frequently-asked-questions/
- Dubai Land Department, official Dubai REST redesign announcement: https://dubailand.gov.ae/en/news-media/dubai-land-department-enhances-dubai-rest-real-estate-services-via-improved-interactive-interface/

These are descriptions of the Dubai service. They must not be read as evidence that identical data feeds, legal processes or integrations are available in Rwanda.

## 2. The product should have two distinct layers

### Layer A — Public market intelligence

**Reference:** DXB Interact's transaction-first market-analysis approach.

Purpose: help buyers and investors understand market activity and compare opportunities.

- Verified transaction register and source provenance.
- Asking-price register shown separately from completed transactions.
- Sale/rent trends with explicit currency, property type and rent period.
- Area-level transaction coverage and project comparables.
- Developer/project dossier, source conflicts, confidence and data gaps.
- Clear source date, verification state and sample size beside market metrics.

### Layer B — Private property services workspace

**Reference:** Dubai REST's role-aware owner and tenant services.

Purpose: help a person or organization manage properties they own, rent, manage or are due to deliver.

- Owner/property portfolio wallet with cash-flow and operating-cost summaries.
- Lease and renewal calendar, deposits, payment schedules, document storage and maintenance log.
- Project-progress watchlist with dated evidence, completion claims, payment milestones and risk alerts.
- Property-document vault with expiry reminders and a history of uploaded versions.
- Broker, property manager, valuer and developer directory with explicit credential evidence and verification dates.
- Case and dispute tracker with submitted documents, steps, communication history and deadlines.
- Notifications for upcoming renewals, unpaid user-entered obligations and reviewed project updates.

Do not merge the private workspace with the public market register. A user's uploaded contract, a broker's claimed fact and an official record are different evidence classes.

## 3. Rwanda-first adaptation

| Dubai REST concept | Taiseel/Rwanda adaptation | Trust rule |
|---|---|---|
| Owner wallet | User-managed property portfolio | Call it **user-declared** until ownership is matched against an authoritative source. |
| Property current value and rental yield | Valuation range, rent evidence and estimated net yield | Show inputs, date, sample size and calculation; do not call an estimate an official valuation. |
| Lease lifecycle | Lease record, renewal reminders, rent schedule and receipt register | Do not claim a lease is officially registered unless registration can be independently confirmed. |
| Rental index | Area rent evidence and comparable contracts/listings | Keep signed contract evidence, public listings and estimates separate. |
| Sale index | Verified transaction trends | Publish only eligible, traceable transaction records; show data coverage and missing-data limits. |
| Off-plan progress and escrow | Project timeline, construction photo log, payment milestones and evidence gaps | Completion rate, escrow account and payment demands require dated source evidence. Never infer an escrow account exists. |
| Broker/developer/valuer directory | Rwanda service-provider register | Store registration/licence evidence, issuing body, identifier, status and last checked date. Unknown is not verified. |
| Document and service requests | Task and case tracker with document versions | Track the user's workflow; do not imply the task was submitted to a government agency unless an actual submission receipt exists. |
| Online fee/payment services | Payment-integration phase only after regulatory and provider review | Do not hold client funds or represent a user-entered receipt as a settled payment. |

### Terminology

Use **Verified official record** only when the issuing authority or a trustworthy, reproducible official interface supports it. Use **Source-documented**, **User-provided**, **Broker-provided**, **Estimated**, **Conflicting** or **Unknown** otherwise.

A source domain alone does not prove that a specific claim is authoritative. Verification applies to a claim and its supporting evidence, not to every statement made by the source.

## 4. Recommended build order

### Phase 1 — Market-data foundation

Continue with the current PR:
- transaction and listing data separation;
- immutable source-linked observations and audit trail;
- controlled importer and verification review;
- market trends and project comparisons;
- test coverage that prevents asking-price records from entering transaction metrics.

### Phase 2 — Secure property workspace

Before building owner/tenant features:
- account authentication and recovery;
- roles and explicit access scopes for owner, tenant, property manager, broker and internal reviewer;
- user-owned property, lease, document, payment-schedule and maintenance records;
- field-level visibility rules where appropriate;
- an append-only audit log for sensitive changes;
- encryption in transit and at rest, retention/deletion policies, backups and tested restoration;
- explicit separation of personal workspace data from market analytics.

Private leases, identity details and ownership documents must never be exposed by public market endpoints.

### Phase 3 — Rwanda verification and integrations

Only after the relevant authority, data access, permissions and legal basis are established:
- official title/parcel lookup or verification;
- official lease/tenancy status where a supported source exists;
- licensed provider and developer verification;
- approved payment-provider connections and transaction receipts;
- valuation-certificate verification where a recognized issuer or registry permits it.

Until then, provide structured document capture and human review, not simulated government integrations.

## 5. Minimum data model for the private workspace

These are future entities, not part of the current market-intelligence migration:

- `workspace_users`, `workspace_memberships`, `workspace_roles` — authenticated users, organizations, membership and permission scope.
- `user_property_claims` — a user’s relationship to a property, with a claim status, evidence links, reviewer decision and timestamps.
- `leases`, `lease_parties`, `lease_events` — contract dates, parties, renewal/cancellation history and source documents.
- `obligations`, `payment_records`, `receipts` — expected amounts and due dates separated from payment confirmations; currency and payment status stay explicit.
- `property_documents`, `document_versions` — secure object-storage references, document type, hashes, dates, access policy and review status. Avoid storing unnecessary personal data in ordinary JSON fields.
- `maintenance_cases`, `case_events` — user-managed work requests, status changes and evidence.
- `provider_profiles`, `provider_credentials`, `credential_checks` — professional claims and dated verification of each credential.
- `workspace_notifications`, `workspace_audit_log` — user-scoped notifications and traceable sensitive actions.

Use separate migrations for these future entities. Do not add them to the public market API without authentication and authorization.

## 6. Acceptance criteria for future owner/tenant features

- One user cannot read another user's leases, documents, wallet, payments or cases by guessing an identifier.
- A user-provided document does not change a claim to **officially verified** automatically.
- Rent and sale comparisons never mix currencies or rent periods silently.
- An asking price never counts as a completed transaction.
- Estimated value and net yield show their calculation inputs and as-of date.
- Every verification decision records who reviewed it, when, the source evidence and the decision status.
- A payment is not labelled successful because a due date passed or a user created a payment record.
- An official integration is labelled live only after an end-to-end test against the authorized service.

## 7. Reference images

Use the official Dubai REST service page for current feature descriptions and brand context. App-store and third-party screenshots can help study navigation patterns, but may show older app versions and should not be treated as evidence of current functionality.

- Official service page: https://dubailand.gov.ae/en/eservices/dubai-rest/
- Official app listing: https://apps.apple.com/ae/app/dubai-rest/id1437805105
