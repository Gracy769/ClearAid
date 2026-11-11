# ClearAid

**Evidence-first humanitarian procurement & verified PayPal disbursements**
*Built for the PayPal AI Developer Challenge 2026*

**Live Deployment:** [https://invoice-ready.graceperez769.workers.dev](https://invoice-ready.graceperez769.workers.dev)

---

## Overview

ClearAid is a control layer between humanitarian funding and field procurement. It does not claim to verify that goods physically arrived; it makes the financial approval decision auditable by combining **PayPal Orders v2** funding, deterministic **Statement of Work (SOW) preflight rate-card checks**, an **Autonomous ReAct AI AP Reconciliation Agent**, **PayPal Payouts** to registered vendors, and an immutable **SHA-256 public transparency ledger** stored in Neon Serverless PostgreSQL.

The hackathon demo uses PayPal Sandbox data and seeded example campaigns. The product is designed for a real pilot with one NGO or pooled-fund operator, where the operator supplies approved SOWs, registered vendors, and invoice evidence. The first measurable outcome is fewer duplicate, out-of-scope, and over-cap invoices reaching payment approval—not a claim of zero fraud.

## Real-world pilot path

1. **Start with one operator, not the whole aid sector.** Partner with one NGO procurement or grants team that already has SOWs, vendor rosters, and invoice review pain.
2. **Import their evidence.** Model each approved budget as a versioned SOW: allowed items, unit ceilings, quantities, currency, and budget owner. Keep the source document hash beside the rules.
3. **Run in shadow mode.** For two weeks, ClearAid reviews real historical or already-approved invoices without controlling payment. Measure duplicate matches, blocked exceptions, reviewer time, and false positives.
4. **Gate one payment rail.** After the operator signs off on the rules, enable PayPal Sandbox first, then production payouts only with dual approval, verified webhook events, and an exportable audit package.

The pilot should report four numbers: invoice review time, percentage of invoices requiring manual rework, value of blocked exceptions, and percentage of approved payments with complete evidence. Those numbers make the product's impact testable.

In the implemented flow, each recorded donation is tied to a PayPal capture, reservations are locked atomically against over-subscription, and a disbursement cannot proceed until the vendor bill clears the configured contract checks and agent gate.

---

## Key Pillars & PayPal Integrations

### 1. Real Inflows: PayPal Orders v2
- Donors select or customize aid amounts across active emergency relief campaigns.
- Orders are created via PayPal Orders v2 and captured via [POST /api/donations/:orderId/capture](src/app/api/donations/%5BorderId%5D/capture/route.ts).
- Webhooks (`PAYMENT.CAPTURE.COMPLETED` and `CHECKOUT.ORDER.APPROVED`) verify real payment captures and append `DONATION_COMPLETED` blocks to the public ledger.

### 2. SOW Rate Card Preflight & Budget Safeguards
- Each humanitarian campaign maintains an approved Statement of Work (SOW) rate card (e.g. trauma surgical packs, water purification skids, shelter generators) with maximum allowable unit rates and quantities.
- Deterministic preflight checks enforce:
  - Exact minor-unit (integer cents) arithmetic to prevent fractional cent drift.
  - SOW item matching with tight semantic overlap checks (`unauthorized_item`).
  - Unit rate ceiling enforcement (`rate_exceeds_sow`).
  - Allocation quota enforcement (`quantity_exceeds_sow`).
  - Campaign uncommitted pool ceiling (`po_cap_exceeded`).

### 3. Autonomous ReAct AI AP Reconciliation Agent
- Powered by Gemini via the Vercel AI SDK with a multi-step deliberation loop.
- Tools:
  - `search_disbursements`: Queries campaign records to prevent duplicate billing and double payouts.
  - `audit_po_terms`: Re-verifies integer minor math, line items, and SOW contract compliance.
  - `record_discrepancy`: Formally documents blocking contract violations.
  - `prepare_approval`: Certifies clean bills with a cryptographic preflight token.
- Gated Approval: Human procurement officers cannot disburse funds unless the autonomous agent explicitly returns `APPROVED`.

### 4. Real Outflows: PayPal Payouts & Atomic Pool Reservation
- Payouts are restricted to admin-registered vetted field contractors.
- Payout amounts are reserved atomically using PostgreSQL row-level locks (`SELECT ... FOR UPDATE`), preventing concurrent double-spends and pool overdrafts.
- [POST /api/disbursements/:id/pay](src/app/api/disbursements/%5Bid%5D/pay/route.ts) dispatches payments via PayPal Payouts API (`/v1/payments/payouts`) with idempotent batch headers (`sender_batch_id`).

### 5. Public Transparency Ledger (Hash Chain)
- Sequenced, tamper-evident SHA-256 linked blocks stored in Neon PostgreSQL:
  $$\text{entry\_hash} = \text{SHA-256}(\text{prev\_hash} + \text{payload\_hash} + \text{kind} + \text{ref\_id})$$
- Publicly auditable at `GET /api/ledger`.
- Cryptographically verified from GENESIS to HEAD at `GET /api/ledger/verify`.

---

## Tech Stack

- **Runtime & Hosting:** Cloudflare Workers (Edge Serverless) via [vinext](https://github.com/vinext/vinext)
- **Framework:** Next.js 16 (App Router + React Server Components)
- **Database:** Neon Serverless PostgreSQL with connection pooling
- **AI Agent:** Google Gemini 2.0 Flash via Vercel AI SDK
- **Payment Infrastructure:** PayPal Orders v2, PayPal Payouts, PayPal Invoicing, PayPal Webhooks
- **Testing:** Node.js native test runner + `tsx` (250+ unit and adversarial stress tests)

---

## Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
copy .env.example .env.local

# 3. Run development server
npm run dev
```

### Environment Variables (`.env.local`)

| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon Serverless PostgreSQL connection string |
| `APP_SECRET` | HMAC secret for signing preflight review approvals |
| `ADMIN_TOKEN` | Bearer token for authorized procurement actions |
| `PAYPAL_CLIENT_ID` | PayPal Sandbox REST App Client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal Sandbox REST App Secret |
| `PAYPAL_WEBHOOK_ID` | Registered PayPal webhook ID |
| `GEMINI_API_KEY` | Google Gemini API Key |
| `GEMINI_MODEL` | `gemini-2.0-flash` |

---

## Test & Verification Suites

```bash
# Run all tests (offline, adversarial, and integration suites)
npm test

# Run ESLint (0 errors, 0 warnings enforced)
npm run lint

# Build edge bundle for Cloudflare Workers
npm run build:vinext
```

---

## Hackathon Judge Notes

- **Admin Access:** To test administrative payout and SOW review actions, open the admin panel or send the header `x-admin-token: rr_admin_relief_judge_2026_9x8f`.
- **Sandbox Environment:** All payments and payouts run in PayPal Sandbox mode. The UI labels this clearly; no live donor money is moved by the demo.
- **Auditing a Bill:** Under the **Audit & Disburse** tab, upload a searchable statement of work or use the pre-filled disaster response invoice. Click **Run Preflight**, then click **Run Autonomous AI Agent Audit**. The AI agent will inspect the campaign rate card and search for duplicate payouts before unlocking the **Approve & Pay via PayPal Payouts** action.

---

## License

MIT
