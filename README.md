<div align="center">
  <h1><img src="public/clearaid-mark.svg" alt="ClearAid logo" width="48" height="48" align="middle" /> ClearAid</h1>
  <h2>Live Video Walkthrough</h2>
</div>

https://github.com/user-attachments/assets/66f234b5-7bfa-4c58-bb96-d5fd7b1f0448

<div align="center">
  <p><strong>Evidence-backed invoice review and auditable PayPal Sandbox disbursements for humanitarian procurement.</strong></p>
  <p><a href="https://invoice-ready.graceperez769.workers.dev">Live demo</a> · Built for the PayPal AI Hackathon 2026</p>
</div>

## The problem

Relief operators must check supplier invoices against approved work, vendor rates, grant limits, and prior payments before funds are released. Manual review makes duplicate, out-of-scope, and over-budget charges harder to catch and explain.

ClearAid gives an operator one review path for that work. It combines PayPal Sandbox payment flows, deterministic invoice controls, an AI reconciliation assistant, a human approval step, and a public hash-linked audit ledger.

The demo uses synthetic campaigns, invoices, and vendors. It demonstrates financial controls; it does **not** verify that goods physically arrived or claim to eliminate fraud. A real pilot would use an NGO's approved SOWs, vendor registry, and review policies.

## How it works

1. **Fund a relief campaign.** A donor starts a PayPal Orders v2 Sandbox checkout. A completed capture is recorded against the campaign and added to the ledger.
2. **Prepare an invoice review.** Choose a campaign and a registered vendor, enter invoice details, and attach searchable source evidence such as a PO or SOW.
3. **Run deterministic checks.** ClearAid checks required fields, integer minor-unit arithmetic, campaign and vendor consistency, SOW items and ceilings, duplicate billing, and the remaining grant pool.
4. **Ask the AI agent to reconcile.** The Gemini-backed agent organizes evidence, checks prior disbursements, and explains discrepancies. It cannot clear a deterministic block or authorize a payment by itself.
5. **Review and approve.** A human reviews the result. Eligible actions use PayPal Sandbox; completed events and decisions are written to the public transparency ledger.
6. **Verify the ledger.** Each entry links to its predecessor with SHA-256 hashes, and the app can recompute the chain from genesis to head.

## Demo walkthrough

On the [live demo](https://invoice-ready.graceperez769.workers.dev):

1. Open **Invoice review & payouts** and choose a campaign.
2. Use a grant-specific demo case. The clean invoice demonstrates an eligible review; over-rate, duplicate, unauthorized-item, and budget-overrun cases demonstrate hard blocks.
3. Run preflight, then the reconciliation agent, and inspect its evidence and explanation.
4. Open **Public Transparency Ledger** to inspect entries and use **Verify Hash Chain**.
5. On **Active Relief Campaigns**, use the PayPal Sandbox donation checkout if you have a Sandbox buyer account.

Payment and payout actions require configured PayPal Sandbox credentials and an authorized admin token. No live funds should be used for this demo.

### Postman health check

Import [`postman/ClearAid API Health.postman_collection.json`](postman/ClearAid%20API%20Health.postman_collection.json) into Postman and run the **Public API health** request. It checks the read-only `/api/status` endpoint for HTTP success, Sandbox mode, and a live database connection; it does not create or change payments.

## What AI does—and what it does not

The AI uses Google Gemini through the Vercel AI SDK and purpose-built reconciliation tools. It can search for prior disbursements, organize invoice/SOW evidence, and explain issues. Deterministic policy checks remain authoritative for arithmetic, SOW limits, duplicate controls, and campaign caps. Human approval remains a separate step before a payment action.

## Stack

- Next.js App Router, React, and TypeScript
- Cloudflare Workers with the Vinext adapter
- Neon Serverless PostgreSQL
- PayPal Orders v2, Payouts, Invoicing, and webhook verification (Sandbox)
- Google Gemini via the Vercel AI SDK
- SHA-256 linked audit records

## Run locally

Requirements: Node.js 22.18 or newer, npm, a Neon database, Google Gemini API key, and PayPal Sandbox app credentials for payment actions.

```bash
npm install
Copy-Item .env.example .env.local
# Fill in the environment values below, then:
npm run dev
```

The app starts at `http://localhost:3000`. It can render with seeded demo data without external credentials, but persistent storage, AI reconciliation, and PayPal actions require their respective values.

### Environment variables

| Variable | Required for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Persistent records and ledger | Neon PostgreSQL connection string. |
| `APP_SECRET` | Signed review approvals | Use a long, random secret. |
| `ADMIN_TOKEN` | Admin-only review and payout actions | Set a private value; enter the same value in the app's admin token field. |
| `PAYPAL_CLIENT_ID` | PayPal Sandbox | REST app client ID. |
| `PAYPAL_CLIENT_SECRET` | PayPal Sandbox | REST app secret. |
| `PAYPAL_SANDBOX` | PayPal environment | Keep `true` for the hackathon demo. |
| `PAYPAL_API_BASE_URL` | PayPal environment | Sandbox API base URL. |
| `PAYPAL_WEBHOOK_ID` | Webhook signature verification | Optional until a Sandbox webhook is registered. |
| `GEMINI_API_KEY` | AI extraction and reconciliation | Google AI Studio API key. |
| `GEMINI_MODEL` | AI model selection | Defaults to `gemini-3.8-flash`; the extraction path falls back to `gemini-2.5-flash` if needed. |
| `APP_URL` | PayPal return and cancel links | Public app URL for deployed environments. |

Never commit `.env.local`, API keys, PayPal credentials, or production tokens. `.env.example` contains names and safe defaults only.

## Deploy to Cloudflare

The repository uses `cloudflare.config.ts` and the Cloudflare CLI. Sign in with `cf auth login` and configure the secret bindings in Cloudflare before deploying.

```bash
npx cf auth whoami
npx cf deploy --dry-run
npx cf deploy --message "ClearAid hackathon release"
```

Required Worker secrets: `DATABASE_URL`, `APP_SECRET`, `ADMIN_TOKEN`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `GEMINI_API_KEY`. Set `PAYPAL_WEBHOOK_ID` if webhook verification is enabled. Non-secret Sandbox settings and the public app URL are declared in `cloudflare.config.ts`.

## Checks

```bash
npm run lint
npm test
npm run build
npm run build:vinext
```

## Project boundaries

- Sandbox and synthetic data are for demonstration, not real fundraising or real disbursement.
- Humanitarian operators remain responsible for vetting vendors, approving SOWs, and authorizing payments.
- The ledger makes recorded events tamper-evident; it cannot establish whether a physical delivery occurred.
- A production pilot needs operator-specific policies, verified identity and vendor onboarding, human dual control, operational monitoring, and legal/compliance review.

## License

MIT. See [LICENSE](LICENSE).
