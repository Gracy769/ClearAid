import { neon } from "@neondatabase/serverless";
import { createHash } from "node:crypto";
import type { ReliefCampaign, Vendor, Disbursement, LedgerEntry, SOWRateCardItem } from "./types";

let schemaReady: Promise<void> | undefined;

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be configured for persistent actions.");
  return neon(url);
}

// ---------------------------------------------------------------------------
// Canonical JSON & Cryptographic SHA-256 Hashing
// ---------------------------------------------------------------------------
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalJson((obj as Record<string, unknown>)[k]));
  return "{" + pairs.join(",") + "}";
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// In-Memory Fallback Stores (for offline test execution / resilience)
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

export interface MemoryDonationRecord {
  id: string;
  campaign_id: string;
  amount_minor: bigint;
  currency: string;
  status: string;
  capture_id: string | null;
  payer_email: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryVendorRecord {
  id: string;
  name: string;
  payout_email: string;
  status: string;
  registered_by: string | null;
  created_at: Date;
}

export interface MemoryDisbursementRecord {
  id: string;
  campaign_id: string;
  vendor_id: string;
  review_id: string;
  amount_minor: bigint;
  currency: string;
  status: string;
  po_number: string | null;
  doc_hash: string | null;
  payout_batch_id: string | null;
  payout_item_id: string | null;
  proof_hash: string;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryLedgerRecord {
  id: number;
  kind: string;
  ref_id: string;
  campaign_id: string | null;
  payload: Record<string, unknown>;
  payload_hash: string;
  prev_hash: string;
  entry_hash: string;
  created_at: Date;
}

const memoryReviews = new Map<string, MemoryReviewRecord>();
const memoryInvoices = new Map<string, MemoryInvoiceRecord>();
const memoryOrders = new Map<string, MemoryOrderRecord>();
const memoryWebhookEvents = new Set<string>();

const memoryCampaigns = new Map<string, ReliefCampaign>();
const memoryDonations = new Map<string, MemoryDonationRecord>();
const memoryVendors = new Map<string, MemoryVendorRecord>();
const memoryDisbursements = new Map<string, MemoryDisbursementRecord>();
const memoryLedgerEntries: MemoryLedgerRecord[] = [];

export function _clearMemoryDb() {
  memoryReviews.clear();
  memoryInvoices.clear();
  memoryOrders.clear();
  memoryWebhookEvents.clear();
  memoryDonations.clear();
  memoryDisbursements.clear();
  memoryLedgerEntries.length = 0;
  resetMemorySeed();
}

// ---------------------------------------------------------------------------
// Seed Data Definitions
// ---------------------------------------------------------------------------
const SEED_RATE_CARDS: Record<string, SOWRateCardItem[]> = {
  "CAMP-MED-01": [
    { description: "Enterprise Multi-VPC Cloud Architecture (Field Telemetry)", maxUnitRate: "250.00", maxQuantity: 30 },
    { description: "Cloudflare Zero Trust & Tunnel Field Routing Nodes", maxUnitRate: "200.00", maxQuantity: 25 },
    { description: "Sterile Trauma Surgical Field Packs", maxUnitRate: "450.00", maxQuantity: 50 },
  ],
  "CAMP-WATER-02": [
    { description: "Solar Reverse Osmosis Mobile Filtration Skids", maxUnitRate: "5000.00", maxQuantity: 5 },
    { description: "Chlorine Sachet Water Purification Pallets (10,000 treatments)", maxUnitRate: "1500.00", maxQuantity: 10 },
  ],
  "CAMP-SHELTER-03": [
    { description: "15kVA Whisper-Quiet Diesel Generators & Panels", maxUnitRate: "4700.00", maxQuantity: 4 },
    { description: "Insulated Cold-Weather Survival Tents (10-Person)", maxUnitRate: "850.00", maxQuantity: 20 },
  ],
};

const SEED_CAMPAIGNS: ReliefCampaign[] = [
  {
    id: "CAMP-MED-01",
    title: "Emergency Trauma Kits & Surgical Field Hospital",
    subtitle: "Direct sterile surgical kits, portable anesthesia, and emergency trauma field stations for coastal cyclone response.",
    category: "Medical",
    targetMinor: 15000000, // $150,000.00
    raisedMinor: 0,
    disbursedMinor: 0,
    currency: "USD",
    grantCode: "GRANT-RELIEF-2026-MED01",
    leadAgency: "Global Emergency Health Corps",
    disasterZone: "Southern Coastal Cyclone Zone (Sector 4)",
    urgent: true,
    sowRateCard: SEED_RATE_CARDS["CAMP-MED-01"],
    sowHash: sha256Hex(canonicalJson(SEED_RATE_CARDS["CAMP-MED-01"])),
  },
  {
    id: "CAMP-WATER-02",
    title: "Clean Water Desalination & Solar Purification Rigs",
    subtitle: "Solar-powered reverse osmosis units and bulk 20L Jerrycan supply to 14,000 displaced families.",
    category: "Water & Sanitation",
    targetMinor: 8000000, // $80,000.00
    raisedMinor: 0,
    disbursedMinor: 0,
    currency: "USD",
    grantCode: "GRANT-RELIEF-2026-WTR02",
    leadAgency: "PureRelief International",
    disasterZone: "Riverine Basin Inundation Corridor",
    urgent: false,
    sowRateCard: SEED_RATE_CARDS["CAMP-WATER-02"],
    sowHash: sha256Hex(canonicalJson(SEED_RATE_CARDS["CAMP-WATER-02"])),
  },
  {
    id: "CAMP-SHELTER-03",
    title: "Rapid Thermal Shelters & Micro-Grid Generators",
    subtitle: "Heavy insulated winter survival tents, 15kVA whisper-quiet diesel generators, and emergency grid batteries.",
    category: "Shelter & Power",
    targetMinor: 12000000, // $120,000.00
    raisedMinor: 0,
    disbursedMinor: 0,
    currency: "USD",
    grantCode: "GRANT-RELIEF-2026-SHL03",
    leadAgency: "Rapid Habitat Response",
    disasterZone: "Alpine Earthquake Fault Sector",
    urgent: true,
    sowRateCard: SEED_RATE_CARDS["CAMP-SHELTER-03"],
    sowHash: sha256Hex(canonicalJson(SEED_RATE_CARDS["CAMP-SHELTER-03"])),
  },
];

const SEED_VENDORS = [
  { id: "VEND-APEX-01", name: "Apex Cloud Systems & Studio Lab Inc.", payout_email: "sb-qb7vt34522927@personal.example.com", registered_by: "ADMIN_SYSTEM" },
  { id: "VEND-OMNI-02", name: "OmniGlobal Operations Corp.", payout_email: "sb-vendor-omni@business.example.com", registered_by: "ADMIN_SYSTEM" },
  { id: "VEND-NORDIC-03", name: "Nordic Field Power Systems LLC", payout_email: "sb-vendor-nordic@business.example.com", registered_by: "ADMIN_SYSTEM" },
];

// Initialize memory seed cache
export function resetMemorySeed() {
  memoryCampaigns.clear();
  for (const camp of SEED_CAMPAIGNS) {
    memoryCampaigns.set(camp.id, { ...camp });
  }
  memoryVendors.clear();
  for (const v of SEED_VENDORS) {
    memoryVendors.set(v.id, {
      id: v.id,
      name: v.name,
      payout_email: v.payout_email,
      status: "ACTIVE",
      registered_by: v.registered_by,
      created_at: new Date(),
    });
  }
}
resetMemorySeed();

// ---------------------------------------------------------------------------
// Database Schema Initialization & Genesis Seeding
// ---------------------------------------------------------------------------
export async function ensureSchema() {
  if (!process.env.DATABASE_URL) return;
  if (!schemaReady) {
    const sql = database();
    schemaReady = (async () => {
      // 1. Core tables
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

      // 2. Relief Ready tables
      await sql`CREATE TABLE IF NOT EXISTS campaigns (
        id text PRIMARY KEY, title text NOT NULL, subtitle text, category text,
        lead_agency text, disaster_zone text, grant_code text UNIQUE,
        target_minor bigint NOT NULL, currency text NOT NULL DEFAULT 'USD',
        urgent boolean DEFAULT false,
        sow_rate_card jsonb, sow_hash text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;

      await sql`CREATE TABLE IF NOT EXISTS donations (
        id text PRIMARY KEY,
        campaign_id text NOT NULL REFERENCES campaigns(id),
        amount_minor bigint NOT NULL CHECK (amount_minor > 0),
        currency text NOT NULL DEFAULT 'USD',
        status text NOT NULL,
        capture_id text, payer_email text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_donations_campaign ON donations(campaign_id, status)`;

      await sql`CREATE TABLE IF NOT EXISTS vendors (
        id text PRIMARY KEY, name text NOT NULL, payout_email text NOT NULL UNIQUE,
        status text NOT NULL DEFAULT 'ACTIVE', registered_by text, created_at timestamptz DEFAULT now()
      )`;

      await sql`CREATE TABLE IF NOT EXISTS disbursements (
        id text PRIMARY KEY, campaign_id text NOT NULL REFERENCES campaigns(id),
        vendor_id text NOT NULL REFERENCES vendors(id), review_id text NOT NULL UNIQUE REFERENCES invoice_reviews(id),
        amount_minor bigint NOT NULL CHECK (amount_minor > 0), currency text NOT NULL DEFAULT 'USD',
        status text NOT NULL,
        po_number text,
        doc_hash text,
        payout_batch_id text, payout_item_id text, proof_hash text NOT NULL,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      )`;
      await sql`ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS po_number text`;
      await sql`ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS doc_hash text`;
      await sql`CREATE INDEX IF NOT EXISTS idx_disbursements_campaign ON disbursements(campaign_id, status)`;

      await sql`CREATE TABLE IF NOT EXISTS ledger_entries (
        id bigserial PRIMARY KEY,
        kind text NOT NULL,
        ref_id text NOT NULL, campaign_id text,
        payload jsonb NOT NULL, payload_hash text NOT NULL,
        prev_hash text NOT NULL UNIQUE, entry_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger_entries(created_at DESC)`;

      // 3. Seed Campaigns
      for (const camp of SEED_CAMPAIGNS) {
        await sql`
          INSERT INTO campaigns (id, title, subtitle, category, lead_agency, disaster_zone, grant_code, target_minor, currency, urgent, sow_rate_card, sow_hash)
          VALUES (${camp.id}, ${camp.title}, ${camp.subtitle}, ${camp.category}, ${camp.leadAgency}, ${camp.disasterZone}, ${camp.grantCode}, ${camp.targetMinor}, ${camp.currency}, ${camp.urgent || false}, ${JSON.stringify(camp.sowRateCard)}::jsonb, ${camp.sowHash || null})
          ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            subtitle = EXCLUDED.subtitle,
            lead_agency = EXCLUDED.lead_agency,
            disaster_zone = EXCLUDED.disaster_zone,
            sow_rate_card = EXCLUDED.sow_rate_card,
            sow_hash = EXCLUDED.sow_hash
        `;
      }

      // 4. Seed Vendors
      for (const v of SEED_VENDORS) {
        await sql`
          INSERT INTO vendors (id, name, payout_email, status, registered_by)
          VALUES (${v.id}, ${v.name}, ${v.payout_email}, 'ACTIVE', ${v.registered_by})
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, payout_email = EXCLUDED.payout_email
        `;
      }
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
}

// ---------------------------------------------------------------------------
// Hash Chain Public Transparency Ledger Operations
// ---------------------------------------------------------------------------
async function appendLedgerInternal(
  sql: ReturnType<typeof neon>,
  kind: string,
  refId: string,
  payload: Record<string, unknown>,
  campaignId?: string
): Promise<{ id: number; entryHash: string; prevHash: string }> {
  const payloadJson = canonicalJson(payload);
  const payloadHash = sha256Hex(payloadJson);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const latestRows = await sql`
        SELECT entry_hash FROM ledger_entries ORDER BY id DESC LIMIT 1
      `;
      const prevHash = latestRows.length > 0 ? (latestRows[0].entry_hash as string) : "GENESIS";
      const entryHash = sha256Hex(prevHash + payloadHash + kind + refId);

      const inserted = await sql`
        INSERT INTO ledger_entries (kind, ref_id, campaign_id, payload, payload_hash, prev_hash, entry_hash)
        VALUES (${kind}, ${refId}, ${campaignId || null}, ${payloadJson}::jsonb, ${payloadHash}, ${prevHash}, ${entryHash})
        RETURNING id, entry_hash, prev_hash
      `;
      if (inserted.length > 0) {
        return {
          id: Number(inserted[0].id),
          entryHash,
          prevHash,
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unique") || msg.includes("prev_hash") || (err as { code?: string }).code === "23505") {
        continue;
      }
      throw err;
    }
  }
  throw new Error("Failed to append to ledger due to high hash chain concurrency.");
}

export async function appendLedger(
  kind: string,
  refId: string,
  payload: Record<string, unknown>,
  campaignId?: string
): Promise<{ id: number; entryHash: string; prevHash: string }> {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      return await appendLedgerInternal(sql, kind, refId, payload, campaignId);
    } catch (err) {
      if (memoryLedgerEntries.length === 0) throw err;
    }
  }

  // In-memory fallback
  const payloadJson = canonicalJson(payload);
  const payloadHash = sha256Hex(payloadJson);
  const prevHash = memoryLedgerEntries.length > 0
    ? memoryLedgerEntries[memoryLedgerEntries.length - 1].entry_hash
    : "GENESIS";
  const entryHash = sha256Hex(prevHash + payloadHash + kind + refId);
  const id = memoryLedgerEntries.length + 1;
  const rec: MemoryLedgerRecord = {
    id,
    kind,
    ref_id: refId,
    campaign_id: campaignId || null,
    payload,
    payload_hash: payloadHash,
    prev_hash: prevHash,
    entry_hash: entryHash,
    created_at: new Date(),
  };
  memoryLedgerEntries.push(rec);
  return { id, entryHash, prevHash };
}

export async function getLedgerEntries(limit = 50, offset = 0): Promise<{ entries: LedgerEntry[]; headHash: string }> {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      const rows = await sql`
        SELECT id, kind, ref_id, campaign_id, payload, payload_hash, prev_hash, entry_hash, created_at
        FROM ledger_entries
        ORDER BY id DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      const headRows = await sql`SELECT entry_hash FROM ledger_entries ORDER BY id DESC LIMIT 1`;
      const headHash = headRows.length > 0 ? (headRows[0].entry_hash as string) : "GENESIS";

      const entries: LedgerEntry[] = rows.map((r) => ({
        id: Number(r.id),
        kind: r.kind as LedgerEntry["kind"],
        refId: r.ref_id as string,
        campaignId: (r.campaign_id as string) || undefined,
        payload: r.payload as Record<string, unknown>,
        payloadHash: r.payload_hash as string,
        prevHash: r.prev_hash as string,
        entryHash: r.entry_hash as string,
        createdAt: (r.created_at as Date).toISOString(),
      }));

      return { entries, headHash };
    } catch {
      // Fall through to memory
    }
  }

  const sorted = [...memoryLedgerEntries].reverse().slice(offset, offset + limit);
  const headHash = memoryLedgerEntries.length > 0
    ? memoryLedgerEntries[memoryLedgerEntries.length - 1].entry_hash
    : "GENESIS";
  return {
    entries: sorted.map((r) => ({
      id: r.id,
      kind: r.kind as LedgerEntry["kind"],
      refId: r.ref_id,
      campaignId: r.campaign_id || undefined,
      payload: r.payload,
      payloadHash: r.payload_hash,
      prevHash: r.prev_hash,
      entryHash: r.entry_hash,
      createdAt: r.created_at.toISOString(),
    })),
    headHash,
  };
}

export async function verifyLedgerChain(): Promise<{
  ok: boolean;
  totalEntries: number;
  headHash: string;
  brokenIndex?: number;
  reason?: string;
}> {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      const rows = await sql`
        SELECT id, kind, ref_id, payload, payload_hash, prev_hash, entry_hash
        FROM ledger_entries
        ORDER BY id ASC
      `;

      if (rows.length === 0) {
        return { ok: true, totalEntries: 0, headHash: "GENESIS" };
      }

      let expectedPrev = "GENESIS";
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.prev_hash !== expectedPrev) {
          return {
            ok: false,
            totalEntries: rows.length,
            headHash: rows[rows.length - 1].entry_hash as string,
            brokenIndex: i,
            reason: `prev_hash mismatch at block #${row.id}: expected ${expectedPrev}, found ${row.prev_hash}`,
          };
        }

        const canonical = canonicalJson(row.payload);
        const computedPayloadHash = sha256Hex(canonical);
        if (computedPayloadHash !== row.payload_hash) {
          return {
            ok: false,
            totalEntries: rows.length,
            headHash: rows[rows.length - 1].entry_hash as string,
            brokenIndex: i,
            reason: `payload_hash tampering detected at block #${row.id}`,
          };
        }

        const computedEntryHash = sha256Hex(row.prev_hash + row.payload_hash + row.kind + row.ref_id);
        if (computedEntryHash !== row.entry_hash) {
          return {
            ok: false,
            totalEntries: rows.length,
            headHash: rows[rows.length - 1].entry_hash as string,
            brokenIndex: i,
            reason: `entry_hash mismatch at block #${row.id}`,
          };
        }

        expectedPrev = row.entry_hash as string;
      }

      return {
        ok: true,
        totalEntries: rows.length,
        headHash: rows[rows.length - 1].entry_hash as string,
      };
    } catch {
      // Fall through to memory
    }
  }

  // Memory verification
  let expectedPrev = "GENESIS";
  for (let i = 0; i < memoryLedgerEntries.length; i++) {
    const entry = memoryLedgerEntries[i];
    if (entry.prev_hash !== expectedPrev) {
      return {
        ok: false,
        totalEntries: memoryLedgerEntries.length,
        headHash: memoryLedgerEntries[memoryLedgerEntries.length - 1]?.entry_hash || "GENESIS",
        brokenIndex: i,
        reason: `prev_hash mismatch in memory block #${entry.id}`,
      };
    }
    const computedPayloadHash = sha256Hex(canonicalJson(entry.payload));
    if (computedPayloadHash !== entry.payload_hash) {
      return {
        ok: false,
        totalEntries: memoryLedgerEntries.length,
        headHash: memoryLedgerEntries[memoryLedgerEntries.length - 1]?.entry_hash || "GENESIS",
        brokenIndex: i,
        reason: `payload tampering in memory block #${entry.id}`,
      };
    }
    const computedEntryHash = sha256Hex(entry.prev_hash + entry.payload_hash + entry.kind + entry.ref_id);
    if (computedEntryHash !== entry.entry_hash) {
      return {
        ok: false,
        totalEntries: memoryLedgerEntries.length,
        headHash: memoryLedgerEntries[memoryLedgerEntries.length - 1]?.entry_hash || "GENESIS",
        brokenIndex: i,
        reason: `entry_hash mismatch in memory block #${entry.id}`,
      };
    }
    expectedPrev = entry.entry_hash;
  }

  return {
    ok: true,
    totalEntries: memoryLedgerEntries.length,
    headHash: expectedPrev,
  };
}

// ---------------------------------------------------------------------------
// Relief Campaigns Operations (Live SQL Aggregates)
// ---------------------------------------------------------------------------
export async function getCampaignsWithAggregates(): Promise<ReliefCampaign[]> {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      const rows = await sql`
        SELECT
          c.id, c.title, c.subtitle, c.category, c.lead_agency, c.disaster_zone,
          c.grant_code, c.target_minor, c.currency, c.urgent, c.sow_rate_card, c.sow_hash,
          COALESCE(don.total_raised, 0)::bigint AS raised_minor,
          COALESCE(disb.total_disbursed, 0)::bigint AS disbursed_minor,
          GREATEST(0, COALESCE(don.total_raised, 0) - COALESCE(disb.total_disbursed, 0))::bigint AS available_minor
        FROM campaigns c
        LEFT JOIN (
          SELECT campaign_id, SUM(amount_minor) AS total_raised
          FROM donations
          WHERE status = 'COMPLETED'
          GROUP BY campaign_id
        ) don ON don.campaign_id = c.id
        LEFT JOIN (
          SELECT campaign_id, SUM(amount_minor) AS total_disbursed
          FROM disbursements
          WHERE status IN ('APPROVED', 'PAYOUT_SUBMITTED', 'PAID', 'APPROVED_PENDING_PAYOUT')
          GROUP BY campaign_id
        ) disb ON disb.campaign_id = c.id
        ORDER BY c.urgent DESC, c.id ASC
      `;

      return rows.map((r) => ({
        id: r.id as string,
        title: r.title as string,
        subtitle: (r.subtitle as string) || "",
        category: (r.category as ReliefCampaign["category"]) || "Medical",
        leadAgency: (r.lead_agency as string) || "",
        disasterZone: (r.disaster_zone as string) || "",
        grantCode: (r.grant_code as string) || "",
        targetMinor: Number(r.target_minor),
        raisedMinor: Number(r.raised_minor),
        disbursedMinor: Number(r.disbursed_minor),
        availableMinor: Number(r.available_minor),
        currency: (r.currency as string) || "USD",
        urgent: Boolean(r.urgent),
        sowRateCard: r.sow_rate_card as SOWRateCardItem[],
        sowHash: (r.sow_hash as string) || undefined,
      }));
    } catch {
      // Fall through to memory
    }
  }

  // Memory aggregates calculation
  return Array.from(memoryCampaigns.values()).map((camp) => {
    let raised = 0n;
    for (const d of memoryDonations.values()) {
      if (d.campaign_id === camp.id && d.status === "COMPLETED") {
        raised += d.amount_minor;
      }
    }
    let disbursed = 0n;
    for (const disb of memoryDisbursements.values()) {
      if (
        disb.campaign_id === camp.id &&
        ["APPROVED", "PAYOUT_SUBMITTED", "PAID", "APPROVED_PENDING_PAYOUT"].includes(disb.status)
      ) {
        disbursed += disb.amount_minor;
      }
    }
    const raisedMinor = Number(raised);
    const disbursedMinor = Number(disbursed);
    const availableMinor = Math.max(0, raisedMinor - disbursedMinor);

    return {
      ...camp,
      raisedMinor,
      disbursedMinor,
      availableMinor,
    };
  });
}

export async function getCampaignById(id: string): Promise<ReliefCampaign | undefined> {
  const all = await getCampaignsWithAggregates();
  return all.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Donations Operations (Orders v2 via Toolkit + Webhooks)
// ---------------------------------------------------------------------------
export async function createDonationRecord(params: {
  id: string; // PayPal Order ID
  campaignId: string;
  amountMinor: number;
  currency?: string;
}): Promise<void> {
  const { id, campaignId, amountMinor, currency = "USD" } = params;

  memoryDonations.set(id, {
    id,
    campaign_id: campaignId,
    amount_minor: BigInt(amountMinor),
    currency,
    status: "CREATED",
    capture_id: null,
    payer_email: null,
    created_at: new Date(),
    updated_at: new Date(),
  });

  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    const sql = database();
    await sql`
      INSERT INTO donations (id, campaign_id, amount_minor, currency, status)
      VALUES (${id}, ${campaignId}, ${amountMinor}, ${currency}, 'CREATED')
      ON CONFLICT (id) DO NOTHING
    `;
  } catch (err) {
    if (!memoryDonations.has(id)) throw err;
  }
}

export async function getDonation(id: string) {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      const rows = await sql`
        SELECT id, campaign_id, amount_minor, currency, status, capture_id, payer_email, created_at, updated_at
        FROM donations
        WHERE id = ${id}
      `;
      if (rows.length > 0) {
        return {
          id: rows[0].id as string,
          campaignId: rows[0].campaign_id as string,
          amountMinor: Number(rows[0].amount_minor),
          currency: rows[0].currency as string,
          status: rows[0].status as string,
          captureId: (rows[0].capture_id as string) || null,
          payerEmail: (rows[0].payer_email as string) || null,
          createdAt: rows[0].created_at as Date,
          updatedAt: rows[0].updated_at as Date,
        };
      }
    } catch {
      // Fall through to memory
    }
  }

  const mem = memoryDonations.get(id);
  if (!mem) return undefined;
  return {
    id: mem.id,
    campaignId: mem.campaign_id,
    amountMinor: Number(mem.amount_minor),
    currency: mem.currency,
    status: mem.status,
    captureId: mem.capture_id,
    payerEmail: mem.payer_email,
    createdAt: mem.created_at,
    updatedAt: mem.updated_at,
  };
}

export async function reserveDonationCapture(id: string): Promise<boolean> {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      const rows = await sql`
        UPDATE donations
        SET status = 'CAPTURING', updated_at = now()
        WHERE id = ${id} AND status = 'CREATED'
        RETURNING id
      `;
      if (rows.length > 0) {
        const mem = memoryDonations.get(id);
        if (mem) {
          mem.status = "CAPTURING";
          mem.updated_at = new Date();
        }
        return true;
      }
      return false;
    } catch {
      // Fall through to memory
    }
  }

  const mem = memoryDonations.get(id);
  if (!mem || mem.status !== "CREATED") return false;
  mem.status = "CAPTURING";
  mem.updated_at = new Date();
  return true;
}

export async function completeDonationCapture(params: {
  id: string;
  captureId: string;
  payerEmail?: string;
  amountMinor?: number;
}): Promise<{ ok: boolean; donation?: ReturnType<typeof getDonation> extends Promise<infer U> ? U : never }> {
  const { id, captureId, payerEmail, amountMinor } = params;

  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      const rows = await sql`
        UPDATE donations
        SET status = 'COMPLETED',
            capture_id = ${captureId},
            payer_email = COALESCE(${payerEmail || null}, payer_email),
            amount_minor = COALESCE(${amountMinor || null}, amount_minor),
            updated_at = now()
        WHERE id = ${id}
        RETURNING id, campaign_id, amount_minor, currency, status, capture_id, payer_email
      `;
      if (rows.length > 0) {
        const row = rows[0];
        const campaignId = row.campaign_id as string;
        const finalMinor = Number(row.amount_minor);

        await appendLedger(
          "DONATION_COMPLETED",
          id,
          {
            orderId: id,
            campaignId,
            amountMinor: finalMinor,
            captureId,
            payerEmail: row.payer_email || null,
          },
          campaignId
        );

        return {
          ok: true,
          donation: {
            id: row.id as string,
            campaignId,
            amountMinor: finalMinor,
            currency: row.currency as string,
            status: "COMPLETED",
            captureId: row.capture_id as string,
            payerEmail: (row.payer_email as string) || null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        };
      }
    } catch {
      // Fall through to memory
    }
  }

  const mem = memoryDonations.get(id);
  if (mem) {
    mem.status = "COMPLETED";
    mem.capture_id = captureId;
    if (payerEmail) mem.payer_email = payerEmail;
    if (amountMinor) mem.amount_minor = BigInt(amountMinor);
    mem.updated_at = new Date();

    await appendLedger(
      "DONATION_COMPLETED",
      id,
      {
        orderId: id,
        campaignId: mem.campaign_id,
        amountMinor: Number(mem.amount_minor),
        captureId,
        payerEmail: mem.payer_email,
      },
      mem.campaign_id
    );

    return {
      ok: true,
      donation: {
        id: mem.id,
        campaignId: mem.campaign_id,
        amountMinor: Number(mem.amount_minor),
        currency: mem.currency,
        status: "COMPLETED",
        captureId: mem.capture_id,
        payerEmail: mem.payer_email,
        createdAt: mem.created_at,
        updatedAt: mem.updated_at,
      },
    };
  }

  return { ok: false };
}

export async function releaseDonationCapture(id: string): Promise<void> {
  const mem = memoryDonations.get(id);
  if (mem && mem.status === "CAPTURING") {
    mem.status = "CREATED";
    mem.updated_at = new Date();
  }

  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    const sql = database();
    await sql`
      UPDATE donations
      SET status = 'CREATED', updated_at = now()
      WHERE id = ${id} AND status = 'CAPTURING'
    `;
  } catch {
    // Memory status reverted
  }
}

// ---------------------------------------------------------------------------
// Vendor Registry Operations (Admin Only)
// ---------------------------------------------------------------------------
export async function getVendors(): Promise<Vendor[]> {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      const rows = await sql`
        SELECT id, name, payout_email, status, registered_by, created_at
        FROM vendors
        ORDER BY created_at DESC
      `;
      return rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        payoutEmail: r.payout_email as string,
        status: r.status as Vendor["status"],
        registeredBy: (r.registered_by as string) || undefined,
        createdAt: (r.created_at as Date).toISOString(),
      }));
    } catch {
      // Fall through to memory
    }
  }

  return Array.from(memoryVendors.values()).map((v) => ({
    id: v.id,
    name: v.name,
    payoutEmail: v.payout_email,
    status: v.status as Vendor["status"],
    registeredBy: v.registered_by || undefined,
    createdAt: v.created_at.toISOString(),
  }));
}

export async function getVendorById(id: string): Promise<Vendor | undefined> {
  const vendors = await getVendors();
  return vendors.find((v) => v.id === id);
}

export async function saveVendor(vendor: {
  id: string;
  name: string;
  payoutEmail: string;
  registeredBy?: string;
}): Promise<void> {
  memoryVendors.set(vendor.id, {
    id: vendor.id,
    name: vendor.name,
    payout_email: vendor.payoutEmail,
    status: "ACTIVE",
    registered_by: vendor.registeredBy || null,
    created_at: new Date(),
  });

  if (!process.env.DATABASE_URL) return;
  try {
    await ensureSchema();
    const sql = database();
    await sql`
      INSERT INTO vendors (id, name, payout_email, status, registered_by)
      VALUES (${vendor.id}, ${vendor.name}, ${vendor.payoutEmail}, 'ACTIVE', ${vendor.registeredBy || null})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        payout_email = EXCLUDED.payout_email,
        status = EXCLUDED.status
    `;
  } catch (err) {
    if (!memoryVendors.has(vendor.id)) throw err;
  }
}

// ---------------------------------------------------------------------------
// Disbursements & Atomic Pool Reservation (Step 2)
// ---------------------------------------------------------------------------
export async function reserveDisbursement(params: {
  id: string;
  campaignId: string;
  vendorId: string;
  reviewId: string;
  amountMinor: number;
  proofHash: string;
  currency?: string;
  poNumber?: string;
  docHash?: string;
}): Promise<{ ok: boolean; disbursementId?: string; error?: string }> {
  const { id, campaignId, vendorId, reviewId, amountMinor, proofHash, currency = "USD", poNumber, docHash } = params;

  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      // Atomic pool reservation locking the campaign row
      const rows = await sql`
        WITH lock AS (SELECT id FROM campaigns WHERE id = ${campaignId} FOR UPDATE)
        INSERT INTO disbursements (id, campaign_id, vendor_id, review_id, amount_minor, currency, status, proof_hash, po_number, doc_hash)
        SELECT ${id}, ${campaignId}, ${vendorId}, ${reviewId}, ${amountMinor}, ${currency}, 'APPROVED', ${proofHash}, ${poNumber || null}, ${docHash || proofHash}
        FROM lock
        WHERE (SELECT COALESCE(SUM(amount_minor), 0) FROM donations WHERE campaign_id = ${campaignId} AND status = 'COMPLETED')
            - (SELECT COALESCE(SUM(amount_minor), 0) FROM disbursements WHERE campaign_id = ${campaignId}
                 AND status IN ('APPROVED', 'PAYOUT_SUBMITTED', 'APPROVED_PENDING_PAYOUT', 'PAID')) >= ${amountMinor}
        RETURNING id
      `;

      if (rows.length === 0) {
        return { ok: false, error: "Insufficient available grant pool in campaign to reserve disbursement." };
      }

      await appendLedger(
        "DISBURSEMENT_APPROVED",
        id,
        {
          disbursementId: id,
          campaignId,
          vendorId,
          reviewId,
          amountMinor,
          proofHash,
          currency,
          poNumber: poNumber || null,
          docHash: docHash || proofHash,
        },
        campaignId
      );

      memoryDisbursements.set(id, {
        id,
        campaign_id: campaignId,
        vendor_id: vendorId,
        review_id: reviewId,
        amount_minor: BigInt(amountMinor),
        currency,
        status: "APPROVED",
        po_number: poNumber || null,
        doc_hash: docHash || proofHash,
        payout_batch_id: null,
        payout_item_id: null,
        proof_hash: proofHash,
        created_at: new Date(),
        updated_at: new Date(),
      });

      return { ok: true, disbursementId: id };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  // Memory fallback reservation check
  const campaigns = await getCampaignsWithAggregates();
  const targetCamp = campaigns.find((c) => c.id === campaignId);
  if (!targetCamp || (targetCamp.availableMinor ?? 0) < amountMinor) {
    return { ok: false, error: "Insufficient available grant pool in campaign to reserve disbursement." };
  }

  memoryDisbursements.set(id, {
    id,
    campaign_id: campaignId,
    vendor_id: vendorId,
    review_id: reviewId,
    amount_minor: BigInt(amountMinor),
    currency,
    status: "APPROVED",
    po_number: poNumber || null,
    doc_hash: docHash || proofHash,
    payout_batch_id: null,
    payout_item_id: null,
    proof_hash: proofHash,
    created_at: new Date(),
    updated_at: new Date(),
  });

  await appendLedger(
    "DISBURSEMENT_APPROVED",
    id,
    {
      disbursementId: id,
      campaignId,
      vendorId,
      reviewId,
      amountMinor,
      proofHash,
      currency,
      poNumber: poNumber || null,
      docHash: docHash || proofHash,
    },
    campaignId
  );

  return { ok: true, disbursementId: id };
}

export async function getDisbursements(campaignId?: string): Promise<Disbursement[]> {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      const rows = campaignId
        ? await sql`
            SELECT d.id, d.campaign_id, d.vendor_id, d.review_id, d.amount_minor, d.currency,
                   d.status, d.payout_batch_id, d.payout_item_id, d.proof_hash,
                   COALESCE(d.po_number, ir.review->'input'->>'poNumber') as po_number,
                   COALESCE(d.doc_hash, d.proof_hash) as doc_hash,
                   d.created_at, d.updated_at,
                   v.name as vendor_name, v.payout_email
            FROM disbursements d
            LEFT JOIN vendors v ON v.id = d.vendor_id
            LEFT JOIN invoice_reviews ir ON ir.id = d.review_id
            WHERE d.campaign_id = ${campaignId}
            ORDER BY d.created_at DESC
          `
        : await sql`
            SELECT d.id, d.campaign_id, d.vendor_id, d.review_id, d.amount_minor, d.currency,
                   d.status, d.payout_batch_id, d.payout_item_id, d.proof_hash,
                   COALESCE(d.po_number, ir.review->'input'->>'poNumber') as po_number,
                   COALESCE(d.doc_hash, d.proof_hash) as doc_hash,
                   d.created_at, d.updated_at,
                   v.name as vendor_name, v.payout_email
            FROM disbursements d
            LEFT JOIN vendors v ON v.id = d.vendor_id
            LEFT JOIN invoice_reviews ir ON ir.id = d.review_id
            ORDER BY d.created_at DESC
          `;

      return rows.map((r) => ({
        id: r.id as string,
        campaignId: r.campaign_id as string,
        vendorId: r.vendor_id as string,
        vendorName: (r.vendor_name as string) || undefined,
        payoutEmail: (r.payout_email as string) || undefined,
        reviewId: r.review_id as string,
        amountMinor: Number(r.amount_minor),
        currency: r.currency as string,
        status: r.status as Disbursement["status"],
        payoutBatchId: (r.payout_batch_id as string) || undefined,
        payoutItemId: (r.payout_item_id as string) || undefined,
        proofHash: r.proof_hash as string,
        poNumber: (r.po_number as string) || undefined,
        docHash: (r.doc_hash as string) || undefined,
        createdAt: (r.created_at as Date).toISOString(),
        updatedAt: (r.updated_at as Date).toISOString(),
      }));
    } catch {
      // Fall through to memory
    }
  }

  const list = Array.from(memoryDisbursements.values());
  const filtered = campaignId ? list.filter((d) => d.campaign_id === campaignId) : list;
  return filtered.map((d) => {
    const v = memoryVendors.get(d.vendor_id);
    return {
      id: d.id,
      campaignId: d.campaign_id,
      vendorId: d.vendor_id,
      vendorName: v?.name,
      payoutEmail: v?.payout_email,
      reviewId: d.review_id,
      amountMinor: Number(d.amount_minor),
      currency: d.currency,
      status: d.status as Disbursement["status"],
      payoutBatchId: d.payout_batch_id || undefined,
      payoutItemId: d.payout_item_id || undefined,
      proofHash: d.proof_hash,
      poNumber: d.po_number || undefined,
      docHash: d.doc_hash || undefined,
      createdAt: d.created_at.toISOString(),
      updatedAt: d.updated_at.toISOString(),
    };
  });
}

export async function getDisbursementById(id: string): Promise<Disbursement | undefined> {
  const all = await getDisbursements();
  return all.find((d) => d.id === id);
}

export async function reserveDisbursementPay(id: string): Promise<boolean> {
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      const rows = await sql`
        UPDATE disbursements
        SET status = 'PAYOUT_SUBMITTED', updated_at = now()
        WHERE id = ${id} AND status = 'APPROVED'
        RETURNING id
      `;
      if (rows.length > 0) {
        const mem = memoryDisbursements.get(id);
        if (mem) {
          mem.status = "PAYOUT_SUBMITTED";
          mem.updated_at = new Date();
        }
        return true;
      }
      return false;
    } catch {
      // Fall through to memory
    }
  }

  const mem = memoryDisbursements.get(id);
  if (!mem || mem.status !== "APPROVED") return false;
  mem.status = "PAYOUT_SUBMITTED";
  mem.updated_at = new Date();
  return true;
}

export async function updateDisbursementStatus(params: {
  id: string;
  status: Disbursement["status"];
  payoutBatchId?: string;
  payoutItemId?: string;
}): Promise<void> {
  const { id, status, payoutBatchId, payoutItemId } = params;

  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const sql = database();
      const rows = await sql`
        UPDATE disbursements
        SET status = ${status},
            payout_batch_id = COALESCE(${payoutBatchId || null}, payout_batch_id),
            payout_item_id = COALESCE(${payoutItemId || null}, payout_item_id),
            updated_at = now()
        WHERE id = ${id}
        RETURNING id, campaign_id, vendor_id, amount_minor
      `;

      if (rows.length > 0) {
        const row = rows[0];
        const campaignId = row.campaign_id as string;
        if (status === "PAID") {
          await appendLedger("PAYOUT_PAID", id, {
            disbursementId: id,
            campaignId,
            vendorId: row.vendor_id,
            amountMinor: Number(row.amount_minor),
            payoutBatchId,
            payoutItemId,
            status,
          }, campaignId);
        } else if (status === "FAILED") {
          await appendLedger("PAYOUT_FAILED", id, {
            disbursementId: id,
            campaignId,
            vendorId: row.vendor_id,
            amountMinor: Number(row.amount_minor),
            payoutBatchId,
            payoutItemId,
            status,
          }, campaignId);
        }
      }
    } catch {
      // Fall through to memory
    }
  }

  const mem = memoryDisbursements.get(id);
  if (mem) {
    mem.status = status;
    if (payoutBatchId) mem.payout_batch_id = payoutBatchId;
    if (payoutItemId) mem.payout_item_id = payoutItemId;
    mem.updated_at = new Date();

    if (status === "PAID") {
      await appendLedger("PAYOUT_PAID", id, {
        disbursementId: id,
        campaignId: mem.campaign_id,
        vendorId: mem.vendor_id,
        amountMinor: Number(mem.amount_minor),
        payoutBatchId,
        payoutItemId,
        status,
      }, mem.campaign_id);
    } else if (status === "FAILED") {
      await appendLedger("PAYOUT_FAILED", id, {
        disbursementId: id,
        campaignId: mem.campaign_id,
        vendorId: mem.vendor_id,
        amountMinor: Number(mem.amount_minor),
        payoutBatchId,
        payoutItemId,
        status,
      }, mem.campaign_id);
    }
  }
}

// ---------------------------------------------------------------------------
// Invoice Review Operations (Existing Backward-Compatible API)
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
      // Fallback to memory
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
// PayPal Invoices Operations (Existing Backward-Compatible API)
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
// PayPal Orders Operations (Existing Backward-Compatible API)
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
      // Fall through to memory
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
      // Fall through to memory
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

      const existingInDb = await database()`
        SELECT id, status FROM paypal_orders WHERE id = ${id}
      `;
      if (existingInDb.length > 0) {
        return false;
      }
    } catch {
      // Fall through to memory
    }
  }

  const mem = memoryOrders.get(id);
  if (!mem || mem.status !== "CREATED") {
    return false;
  }
  mem.status = "CAPTURING";
  mem.updated_at = new Date();
  return true;
}

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
    // Memory status reverted
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

  const directReview = await getReview(identifier);
  if (directReview) {
    return { ...directReview, reviewId: identifier };
  }

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

  const memInvoice = memoryInvoices.get(identifier);
  if (memInvoice?.review_id) {
    const rev = await getReview(memInvoice.review_id);
    if (rev) return { ...rev, reviewId: memInvoice.review_id };
  }

  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
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
      // Fall through to memory
    }
  }

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
      // Fall through to memory
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
