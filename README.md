# Invoice Ready

Invoice Ready helps service vendors review an invoice against a purchase order or statement of work before creating and sending it through PayPal. It runs in PayPal sandbox mode and requires separate approval for draft creation and sending.

## Features

- Manual invoice entry or searchable PDF intake (8 MB maximum).
- Optional Gemini field extraction. Extracted values remain editable; deterministic checks decide whether an invoice is ready.
- Exact minor-unit arithmetic, required-field checks, currency and email validation, and optional PO-cap enforcement.
- Source snippets and page numbers where extracted values match searchable PDF text. Original PDFs are processed in memory and are not stored.
- PayPal sandbox draft and send actions through the PayPal TypeScript Agent Toolkit.
- Signature-verified, deduplicated PayPal invoicing webhooks.
- Neon persistence for reviews, invoice status, and webhook event IDs.

## Requirements

- Node.js 22.23+ or 24.22+
- Wrangler authenticated to the target Cloudflare account
- A PayPal sandbox REST app with Invoicing enabled
- A Neon Postgres database
- Gemini API key for assisted extraction (manual entry works without it)

## Run locally

```bash
npm install
Copy-Item .env.example .env.local
npm run dev
```

Set the server-side values in `.env.local`:

| Variable | Purpose |
| --- | --- |
| `PAYPAL_CLIENT_ID` | PayPal sandbox app client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal sandbox app secret |
| `PAYPAL_WEBHOOK_ID` | Webhook ID registered for the sandbox app |
| `APP_SECRET` | Random secret used to bind approvals to a reviewed invoice |
| `DATABASE_URL` | Neon Postgres connection string |
| `GEMINI_API_KEY` | Optional Gemini API key |
| `GEMINI_MODEL` | Optional model name; defaults to `gemini-2.5-flash` |

Generate `APP_SECRET` with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep all credentials on the server and never commit `.env.local`.

The database tables are created on first use. Configure the PayPal webhook URL as `https://YOUR_HOST/api/paypal/webhooks/invoicing` and subscribe to invoice paid, cancelled, refunded, and partially paid events.

## Deploy to Cloudflare Workers

The deployment configuration is in `wrangler.jsonc`. Add `DATABASE_URL` and `APP_SECRET` with `wrangler secret put` before the first deployment. Add the PayPal sandbox credentials and webhook ID to enable invoice actions and event processing. Then run:

```bash
npm run deploy:cloudflare
```

This builds the app, stages the Worker and static assets, and deploys them with Wrangler. The deployment uses the Cloudflare Workers dev subdomain configured for the account.

## Checks

```bash
npm run lint
npm test
npm run build:vinext
```

## Sandbox flow

1. Upload a searchable PO/SOW PDF or enter invoice details manually.
2. Review and correct extracted values and inspect preflight findings.
3. Approve creation of a PayPal sandbox draft.
4. Inspect the hosted PayPal invoice page, then separately approve sending.
5. PayPal webhooks update the stored invoice state; duplicate event IDs are ignored.

The application is sandbox-only. Configure Neon to save reviews; configure PayPal credentials as well to enable draft and send actions. It does not process live payments.

## License

MIT. See [LICENSE](LICENSE).
