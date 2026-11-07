import { neon } from "@neondatabase/serverless";

let schemaReady: Promise<void> | undefined;

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be configured for persistent invoice actions.");
  return neon(url);
}

// ---------------------------------------------------------------------------
// In-Memory Fallback Store (for resilient offline execution / testing)
// ---------------------------------------------------------------------------
export interface MemoryReviewRecord {
  id: string;
  review: unknown;
  approval_hash: string;
  created_at: Date;
}

export interface MemoryInvoiceRecord {
  id: string;
  review_id: string;
  status: string;
  updated_at: Date;
}

export interface MemoryOrderRecord {
  id: string;
  review_id: string;
  status: string;
  capture_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const memoryReviews = new Map<string, MemoryReviewRecord>();
const memoryInvoices = new Map<string, MemoryInvoiceRecord>();
const memoryOrders = new Map<string, MemoryOrderRecord>();
const memoryWebhookEvents = new Set<string>();

export function _clearMemoryDb() {
  memoryReviews.clear();
  memoryInvoices.clear();
  memoryOrders.clear();
  memoryWebhookEvents.clear();
}

// ---------------------------------------------------------------------------
// Database Schema Initialization
// ---------------------------------------------------------------------------
export async function ensureSchema() {
  if (!process.env.DATABASE_URL) return;
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
      await sql`CREATE TABLE IF NOT EXISTS paypal_orders (
        id text PRIMARY KEY, review_id text NOT NULL,
        status text NOT NULL, capture_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_paypal_orders_review_id ON paypal_orders(review_id)`;
      await sql`ALTER TABLE paypal_orders DROP CONSTRAINT IF EXISTS paypal_orders_review_id_fkey`;
      await sql`CREATE TABLE IF NOT EXISTS paypal_webhook_events (
        event_id text PRIMARY KEY, event_type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
      )`;
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
}

// ---------------------------------------------------------------------------
// Invoice Review Operations
// ---------------------------------------------------------------------------
export async function saveReview(id: string, review: unknown, approvalHash: string) {
  memoryReviews.set(id, {
    id,
    review,
    approval_hash: approvalHash,
    created_at: new Date(),
  });

  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    await database()`INSERT INTO invoice_reviews (id, review, approval_hash)
      VALUES (${id}, ${JSON.stringify(review)}::jsonb, ${approvalHash})
      ON CONFLICT (id) DO UPDATE SET review = EXCLUDED.review, approval_hash = EXCLUDED.approval_hash`;
  } catch (err) {
    // Retain in-memory fallback if database is offline
    if (!memoryReviews.has(id)) throw err;
  }
}

export async function getReview(id: string) {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const rows = await database()`SELECT review, approval_hash FROM invoice_reviews WHERE id = ${id}`;
      if (rows.length > 0) {
        return rows[0] as { review: unknown; approval_hash: string };
      }
    } catch {
      // Fallback to in-memory store if DB query fails
    }
  }

  const mem = memoryReviews.get(id);
  if (mem) {
    return { review: mem.review, approval_hash: mem.approval_hash };
  }
  return undefined;
}

export async function updateReviewStatus(id: string, status: string) {
  const mem = memoryReviews.get(id);
  if (mem && typeof mem.review === "object" && mem.review !== null) {
    mem.review = { ...(mem.review as Record<string, unknown>), status };
  }

  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    await database()`
      UPDATE invoice_reviews
      SET review = jsonb_set(review, '{status}', ${JSON.stringify(status)}::jsonb)
      WHERE id = ${id}
    `;
  } catch (err) {
    if (!mem) throw err;
  }
}

// ---------------------------------------------------------------------------
// PayPal Invoices Operations
// ---------------------------------------------------------------------------
export async function savePaypalInvoice(id: string, reviewId: string, status: string) {
  memoryInvoices.set(id, { id, review_id: reviewId, status, updated_at: new Date() });

  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    await database()`INSERT INTO paypal_invoices (id, review_id, status)
      VALUES (${id}, ${reviewId}, ${status})
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`;
  } catch (err) {
    if (!memoryInvoices.has(id)) throw err;
  }
}

export async function reserveInvoiceDraft(reviewId: string) {
  const pendingId = `pending-${reviewId}`;

  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const rows = await database()`INSERT INTO paypal_invoices (id, review_id, status)
        VALUES (${pendingId}, ${reviewId}, 'CREATING')
        ON CONFLICT (review_id) DO NOTHING RETURNING id`;
      if (rows.length > 0) {
        memoryInvoices.set(pendingId, { id: pendingId, review_id: reviewId, status: "CREATING", updated_at: new Date() });
        return pendingId;
      }
      return null;
    } catch {
      // Fall through to memory
    }
  }

  // Check if any invoice exists for this reviewId
  for (const inv of memoryInvoices.values()) {
    if (inv.review_id === reviewId) return null;
  }
  memoryInvoices.set(pendingId, { id: pendingId, review_id: reviewId, status: "CREATING", updated_at: new Date() });
  return pendingId;
}

export async function commitInvoiceDraft(pendingId: string, paypalId: string, status: string) {
  const mem = memoryInvoices.get(pendingId);
  if (mem) {
    memoryInvoices.delete(pendingId);
    memoryInvoices.set(paypalId, { id: paypalId, review_id: mem.review_id, status, updated_at: new Date() });
  }

  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    await database()`UPDATE paypal_invoices SET id = ${paypalId}, status = ${status}, updated_at = now() WHERE id = ${pendingId}`;
  } catch (err) {
    if (!mem) throw err;
  }
}

export async function releaseInvoiceDraft(pendingId: string) {
  memoryInvoices.delete(pendingId);

  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    await database()`DELETE FROM paypal_invoices WHERE id = ${pendingId} AND status = 'CREATING'`;
  } catch {
    // Memory deleted
  }
}

export async function reserveInvoiceSend(id: string, reviewId: string) {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const rows = await database()`UPDATE paypal_invoices SET status = 'SENDING', updated_at = now() WHERE id = ${id} AND review_id = ${reviewId} AND status IN ('DRAFT', 'PENDING') RETURNING id`;
      if (rows.length > 0) {
        const mem = memoryInvoices.get(id);
        if (mem) mem.status = "SENDING";
        return true;
      }
      return false;
    } catch {
      // Fall through to memory
    }
  }

  const mem = memoryInvoices.get(id);
  if (mem && mem.review_id === reviewId && (mem.status === "DRAFT" || mem.status === "PENDING")) {
    mem.status = "SENDING";
    mem.updated_at = new Date();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PayPal Orders Operations (Orders v2 Instant Settlement)
// ---------------------------------------------------------------------------
export async function savePaypalOrder(id: string, reviewId: string, status: string, captureId?: string) {
  memoryOrders.set(id, {
    id,
    review_id: reviewId,
    status,
    capture_id: captureId || null,
    created_at: new Date(),
    updated_at: new Date(),
  });

  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    await database()`
      INSERT INTO invoice_reviews (id, review, approval_hash)
      VALUES (${reviewId}, '{"status":"READY"}'::jsonb, 'auto-generated')
      ON CONFLICT (id) DO NOTHING
    `.catch(() => {});
    await database()`
      INSERT INTO paypal_orders (id, review_id, status, capture_id)
      VALUES (${id}, ${reviewId}, ${status}, ${captureId || null})
      ON CONFLICT (id) DO UPDATE SET
        review_id = EXCLUDED.review_id,
        status = EXCLUDED.status,
        capture_id = COALESCE(EXCLUDED.capture_id, paypal_orders.capture_id),
        updated_at = now()
    `;
  } catch (err) {
    if (!memoryOrders.has(id)) throw err;
  }
}

export async function getPaypalOrder(id: string) {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const rows = await database()`
        SELECT id, review_id, status, capture_id, created_at, updated_at
        FROM paypal_orders
        WHERE id = ${id}
      `;
      if (rows.length > 0) {
        return rows[0] as {
          id: string;
          review_id: string;
          status: string;
          capture_id: string | null;
          created_at: Date;
          updated_at: Date;
        };
      }
    } catch {
      // Fall back to memory
    }
  }

  const mem = memoryOrders.get(id);
  if (mem) {
    return {
      id: mem.id,
      review_id: mem.review_id,
      status: mem.status,
      capture_id: mem.capture_id,
      created_at: mem.created_at,
      updated_at: mem.updated_at,
    };
  }
  return undefined;
}

export async function getOrderByReviewId(reviewId: string) {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const rows = await database()`
        SELECT id, review_id, status, capture_id
        FROM paypal_orders
        WHERE review_id = ${reviewId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (rows.length > 0) {
        return rows[0] as {
          id: string;
          review_id: string;
          status: string;
          capture_id: string | null;
        };
      }
    } catch {
      // Fall back to memory
    }
  }

  for (const order of memoryOrders.values()) {
    if (order.review_id === reviewId) {
      return {
        id: order.id,
        review_id: order.review_id,
        status: order.status,
        capture_id: order.capture_id,
      };
    }
  }
  return undefined;
}

/**
 * Atomically reserves an order for capture. Returns true if the order was
 * successfully transitioned from 'CREATED' to 'CAPTURING'; false if it was
 * already in 'CAPTURING', 'COMPLETED', or not found.
 */
export async function reserveOrderCapture(id: string): Promise<boolean> {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const rows = await database()`
        UPDATE paypal_orders
        SET status = 'CAPTURING', updated_at = now()
        WHERE id = ${id} AND status = 'CREATED'
        RETURNING id
      `;
      if (rows.length > 0) {
        const mem = memoryOrders.get(id);
        if (mem) {
          mem.status = "CAPTURING";
          mem.updated_at = new Date();
        }
        return true;
      }

      // Check whether order exists in PostgreSQL
      const existingInDb = await database()`
        SELECT id, status FROM paypal_orders WHERE id = ${id}
      `;
      if (existingInDb.length > 0) {
        // Order exists in PostgreSQL, but status was not 'CREATED' (e.g. CAPTURING or COMPLETED)
        return false;
      }
      // If order is not found in PostgreSQL at all, fall through to in-memory store
    } catch {
      // Fall through to in-memory store on DB failure
    }
  }

  // In-memory store fallback
  const mem = memoryOrders.get(id);
  if (!mem || mem.status !== "CREATED") {
    return false;
  }
  mem.status = "CAPTURING";
  mem.updated_at = new Date();
  return true;
}

/**
 * Releases/rolls back an order capture reservation if payment capture fails or errors.
 * Reverts status from 'CAPTURING' back to 'CREATED'.
 */
export async function releaseOrderCaptureReservation(id: string): Promise<void> {
  const mem = memoryOrders.get(id);
  if (mem && mem.status === "CAPTURING") {
    mem.status = "CREATED";
    mem.updated_at = new Date();
  }

  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    await database()`
      UPDATE paypal_orders
      SET status = 'CREATED', updated_at = now()
      WHERE id = ${id} AND status = 'CAPTURING'
    `;
  } catch {
    // Memory status already reverted
  }
}

export async function updatePaypalOrderCapture(id: string, arg1: string, arg2?: string) {
  let status = "COMPLETED";
  let captureId = "";
  if (arg2 !== undefined) {
    if (arg1 === "COMPLETED" || arg1 === "CREATED" || arg1 === "SAVED") {
      status = arg1;
      captureId = arg2;
    } else {
      captureId = arg1;
      status = arg2;
    }
  } else {
    captureId = arg1;
  }

  const mem = memoryOrders.get(id);
  if (mem) {
    mem.status = status;
    mem.capture_id = captureId;
    mem.updated_at = new Date();
  }

  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    await database()`
      UPDATE paypal_orders
      SET status = ${status}, capture_id = ${captureId}, updated_at = now()
      WHERE id = ${id}
    `;
  } catch (err) {
    if (!mem) throw err;
  }
}

// ---------------------------------------------------------------------------
// Unified Correlation Lookup
// ---------------------------------------------------------------------------
export async function findReviewByInvoiceOrTransaction(identifier: string): Promise<
  | { review: unknown; approval_hash: string; reviewId?: string }
  | undefined
> {
  if (!identifier) return undefined;

  // 1. Direct review lookup
  const directReview = await getReview(identifier);
  if (directReview) {
    return { ...directReview, reviewId: identifier };
  }

  // 2. Lookup via Orders v2 (Order ID or Capture ID)
  const order = await getPaypalOrder(identifier);
  if (order?.review_id) {
    const rev = await getReview(order.review_id);
    if (rev) return { ...rev, reviewId: order.review_id };
  }

  for (const o of memoryOrders.values()) {
    if (o.id === identifier || o.capture_id === identifier) {
      const rev = await getReview(o.review_id);
      if (rev) return { ...rev, reviewId: o.review_id };
    }
  }

  // 3. Lookup via Invoicing (Invoice ID)
  const memInvoice = memoryInvoices.get(identifier);
  if (memInvoice?.review_id) {
    const rev = await getReview(memInvoice.review_id);
    if (rev) return { ...rev, reviewId: memInvoice.review_id };
  }

  // 4. Database join queries if DB is online
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      // Try orders by capture_id or id
      const orderRows = await database()`
        SELECT ir.id as review_id, ir.review, ir.approval_hash
        FROM paypal_orders po
        JOIN invoice_reviews ir ON po.review_id = ir.id
        WHERE po.id = ${identifier} OR po.capture_id = ${identifier}
        LIMIT 1
      `;
      if (orderRows.length > 0) {
        return {
          review: orderRows[0].review,
          approval_hash: orderRows[0].approval_hash as string,
          reviewId: orderRows[0].review_id as string,
        };
      }

      // Try invoices by id
      const invRows = await database()`
        SELECT ir.id as review_id, ir.review, ir.approval_hash
        FROM paypal_invoices pi
        JOIN invoice_reviews ir ON pi.review_id = ir.id
        WHERE pi.id = ${identifier}
        LIMIT 1
      `;
      if (invRows.length > 0) {
        return {
          review: invRows[0].review,
          approval_hash: invRows[0].approval_hash as string,
          reviewId: invRows[0].review_id as string,
        };
      }

      // Try PO number search in review input JSONB
      const poRows = await database()`
        SELECT id as review_id, review, approval_hash
        FROM invoice_reviews
        WHERE review->'input'->>'poNumber' = ${identifier}
        LIMIT 1
      `;
      if (poRows.length > 0) {
        return {
          review: poRows[0].review,
          approval_hash: poRows[0].approval_hash as string,
          reviewId: poRows[0].review_id as string,
        };
      }
    } catch {
      // Database query failed; fall through to memory PO check
    }
  }

  // 5. Memory PO number check
  for (const r of memoryReviews.values()) {
    const revObj = r.review as Record<string, unknown> | undefined;
    const input = revObj?.input as Record<string, unknown> | undefined;
    if (input?.poNumber === identifier) {
      return { review: r.review, approval_hash: r.approval_hash, reviewId: r.id };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Webhook Events
// ---------------------------------------------------------------------------
export async function recordWebhook(
  eventId: string,
  eventType: string,
  invoiceId: string | null,
  status: string | null
) {
  if (memoryWebhookEvents.has(eventId)) {
    return false;
  }
  memoryWebhookEvents.add(eventId);

  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      const inserted = await sql`
        INSERT INTO paypal_webhook_events (event_id, event_type)
        VALUES (${eventId}, ${eventType})
        ON CONFLICT DO NOTHING
        RETURNING event_id
      `;
      if (!inserted.length) return false;
      if (invoiceId && status) {
        await sql`UPDATE paypal_invoices SET status = ${status}, updated_at = now() WHERE id = ${invoiceId}`;
        const mem = memoryInvoices.get(invoiceId);
        if (mem) {
          mem.status = status;
          mem.updated_at = new Date();
        }
      }
      return true;
    } catch {
      // Memory store already marked
    }
  }

  if (invoiceId && status) {
    const mem = memoryInvoices.get(invoiceId);
    if (mem) {
      mem.status = status;
      mem.updated_at = new Date();
    }
  }
  return true;
}
