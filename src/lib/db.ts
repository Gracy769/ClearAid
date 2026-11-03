import { neon } from "@neondatabase/serverless";

let schemaReady: Promise<void> | undefined;

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be configured for persistent invoice actions.");
  return neon(url);
}

export async function ensureSchema() {
  if (!schemaReady) {
    const sql = database();
    schemaReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS invoice_reviews (
        id text PRIMARY KEY, review jsonb NOT NULL, approval_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS paypal_invoices (
        id text PRIMARY KEY, review_id text NOT NULL UNIQUE REFERENCES invoice_reviews(id),
        status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS paypal_webhook_events (
        event_id text PRIMARY KEY, event_type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
      )`;
    })().catch((error) => { schemaReady = undefined; throw error; });
  }
  await schemaReady;
}

export async function saveReview(id: string, review: unknown, approvalHash: string) {
  await ensureSchema();
  await database()`INSERT INTO invoice_reviews (id, review, approval_hash) VALUES (${id}, ${JSON.stringify(review)}::jsonb, ${approvalHash})`;
}

export async function getReview(id: string) {
  await ensureSchema();
  const rows = await database()`SELECT review, approval_hash FROM invoice_reviews WHERE id = ${id}`;
  return rows[0] as { review: unknown; approval_hash: string } | undefined;
}

export async function savePaypalInvoice(id: string, reviewId: string, status: string) {
  await ensureSchema();
  await database()`INSERT INTO paypal_invoices (id, review_id, status) VALUES (${id}, ${reviewId}, ${status}) ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`;
}

export async function reserveInvoiceDraft(reviewId: string) {
  await ensureSchema();
  const pendingId = `pending-${reviewId}`;
  const rows = await database()`INSERT INTO paypal_invoices (id, review_id, status) VALUES (${pendingId}, ${reviewId}, 'CREATING') ON CONFLICT (review_id) DO NOTHING RETURNING id`;
  return rows.length > 0 ? pendingId : null;
}

export async function commitInvoiceDraft(pendingId: string, paypalId: string, status: string) {
  await ensureSchema();
  await database()`UPDATE paypal_invoices SET id = ${paypalId}, status = ${status}, updated_at = now() WHERE id = ${pendingId}`;
}

export async function releaseInvoiceDraft(pendingId: string) {
  await ensureSchema();
  await database()`DELETE FROM paypal_invoices WHERE id = ${pendingId} AND status = 'CREATING'`;
}

export async function reserveInvoiceSend(id: string, reviewId: string) {
  await ensureSchema();
  const rows = await database()`UPDATE paypal_invoices SET status = 'SENDING', updated_at = now() WHERE id = ${id} AND review_id = ${reviewId} AND status IN ('DRAFT', 'PENDING') RETURNING id`;
  return rows.length > 0;
}

export async function recordWebhook(eventId: string, eventType: string, invoiceId: string | null, status: string | null) {
  await ensureSchema();
  const sql = database();
  const inserted = await sql`INSERT INTO paypal_webhook_events (event_id, event_type) VALUES (${eventId}, ${eventType}) ON CONFLICT DO NOTHING RETURNING event_id`;
  if (!inserted.length) return false;
  if (invoiceId && status) await sql`UPDATE paypal_invoices SET status = ${status}, updated_at = now() WHERE id = ${invoiceId}`;
  return true;
}
