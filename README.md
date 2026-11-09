# Relief Ready

**Transparent Humanitarian Aid & Verified PayPal Disbursements**  
*Built for the PayPal AI Developer Challenge 2026*

**Live Deployment:** [https://invoice-ready.graceperez769.workers.dev](https://invoice-ready.graceperez769.workers.dev)

---

## Overview

Relief Ready bridges donor generosity and humanitarian aid execution with mathematical transparency. It eliminates administrative leakage and fraudulent billing in disaster response by combining **PayPal Orders v2** donation capture, deterministic **Statement of Work (SOW) preflight rate card audits**, an **Autonomous ReAct AI AP Reconciliation Agent**, **PayPal Payouts** to vetted contractors, and an immutable **SHA-256 Public Transparency Ledger** stored in Neon Serverless PostgreSQL.

Every dollar entering the pool is captured via verified PayPal transactions, locked atomically against over-subscription, and disbursed only after vendor bills clear automated contract reconciliation.

---

## Key Pillars & PayPal Integrations

### 1. Real Inflows: PayPal Orders v2
- Donors select or customize aid amounts across active emergency relief campaigns.
- Orders are created via PayPal Orders v2 and captured via [POST /api/donations/:orderId/capture](file:///d:/Nvid/invoice-ready/src/app/api/donations/[orderId]/capture/route.ts).
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
- [POST /api/disbursements/:id/pay](file:///d:/Nvid/invoice-ready/src/app/api/disbursements/[id]/pay/route.ts) dispatches payments via PayPal Payouts API (`/v1/payments/payouts`) with idempotent batch headers (`sender_batch_id`).

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
- **Sandbox Environment:** All payments and payouts run in PayPal Sandbox mode.
- **Auditing a Bill:** Under the **Audit & Disburse** tab, upload a searchable statement of work or use the pre-filled disaster response invoice. Click **Run Preflight**, then click **Run Autonomous AI Agent Audit**. The AI agent will inspect the campaign rate card and search for duplicate payouts before unlocking the **Approve & Pay via PayPal Payouts** action.

---

## License

MIT
