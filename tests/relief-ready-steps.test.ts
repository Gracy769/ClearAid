import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV1 } from "ai/test";
import { runPreflight } from "../src/lib/preflight";
import { runReconciliationAgent } from "../src/lib/agent/reconciliation-agent";
import {
  _clearMemoryDb,
  appendLedger,
  verifyLedgerChain,
  reserveDisbursement,
  completeDonationCapture,
  reserveDonationCapture,
  createDonationRecord,
  getDonation,
  saveVendor,
  saveReview,
} from "../src/lib/db";
import type { ReviewInput, SOWRateCardItem } from "../src/lib/types";

describe("Relief Ready Steps 1-4 Verification Suite", () => {
  beforeEach(() => {
    _clearMemoryDb();
  });

  describe("Step 3: SOW Rate Card Audit & Preflight Guardrails", () => {
    const rateCard: SOWRateCardItem[] = [
      { description: "Enterprise Multi-VPC Cloud Architecture", maxUnitRate: "250.00", maxQuantity: 30 },
      { description: "Cloudflare Zero Trust & Tunnel Field Routing", maxUnitRate: "200.00", maxQuantity: 25 },
    ];

    it("passes cleanly when bill items match SOW rate card within limits", () => {
      const input: ReviewInput = {
        vendorName: "Apex Cloud Systems & Studio Lab Inc.",
        buyerName: "Global Emergency Health Corps",
        buyerEmail: "procurement@gehc.org",
        poNumber: "GRANT-RELIEF-2026-MED01",
        currency: "USD",
        poCap: "20000.00",
        items: [
          { description: "Enterprise Multi-VPC Cloud Architecture", quantity: "20", unitAmount: "250.00" },
          { description: "Cloudflare Zero Trust & Tunnel Field Routing", quantity: "15", unitAmount: "200.00" },
        ],
        evidence: [{ document: "Grant-SOW.pdf", quote: "Terms verified" }],
        sourceTerms: {
          vendorName: "Apex Cloud Systems & Studio Lab Inc.",
          buyerName: "Global Emergency Health Corps",
          buyerEmail: "procurement@gehc.org",
          poNumber: "GRANT-RELIEF-2026-MED01",
          currency: "USD",
          rateCard,
        },
      };

      const result = runPreflight(input);
      assert.equal(result.status, "READY");
      assert.equal(result.findings.filter((f) => f.severity === "block").length, 0);
      assert.equal(result.totalMinor, 20 * 25000 + 15 * 20000);
    });

    it("blocks invoice when unit rate exceeds SOW rate card ceiling", () => {
      const input: ReviewInput = {
        vendorName: "Apex Cloud Systems & Studio Lab Inc.",
        buyerName: "Global Emergency Health Corps",
        buyerEmail: "procurement@gehc.org",
        poNumber: "GRANT-RELIEF-2026-MED01",
        currency: "USD",
        poCap: "50000.00",
        items: [
          // Exceeds maxUnitRate of $250.00 with $900.00
          { description: "Enterprise Multi-VPC Cloud Architecture", quantity: "10", unitAmount: "900.00" },
        ],
        evidence: [{ document: "Grant-SOW.pdf", quote: "Rate card" }],
        sourceTerms: {
          rateCard,
        },
      };

      const result = runPreflight(input);
      assert.equal(result.status, "HOLD");
      const rateExceeded = result.findings.find((f) => f.code.startsWith("rate_exceeds_sow"));
      assert.ok(rateExceeded);
      assert.ok(rateExceeded.message.includes("exceeds SOW maximum $250.00"));
      assert.ok(rateExceeded.message.includes("$650.00/unit"));
    });

    it("blocks invoice when quantity exceeds SOW allocated quota", () => {
      const input: ReviewInput = {
        vendorName: "Apex Cloud Systems & Studio Lab Inc.",
        buyerName: "Global Emergency Health Corps",
        buyerEmail: "procurement@gehc.org",
        poNumber: "GRANT-RELIEF-2026-MED01",
        currency: "USD",
        items: [
          // 40 exceeds maxQuantity of 30
          { description: "Enterprise Multi-VPC Cloud Architecture", quantity: "40", unitAmount: "250.00" },
        ],
        evidence: [{ document: "Grant-SOW.pdf", quote: "Quota" }],
        sourceTerms: {
          rateCard,
        },
      };

      const result = runPreflight(input);
      assert.equal(result.status, "HOLD");
      const qtyExceeded = result.findings.find((f) => f.code.startsWith("quantity_exceeds_sow"));
      assert.ok(qtyExceeded);
      assert.ok(qtyExceeded.message.includes("exceeds SOW allocation of 30"));
    });

    it("blocks unapproved aid item not listed in campaign SOW", () => {
      const input: ReviewInput = {
        vendorName: "Apex Cloud Systems & Studio Lab Inc.",
        buyerName: "Global Emergency Health Corps",
        buyerEmail: "procurement@gehc.org",
        poNumber: "GRANT-RELIEF-2026-MED01",
        currency: "USD",
        items: [
          { description: "Luxury VIP Charter Helicopter Transport", quantity: "1", unitAmount: "15000.00" },
        ],
        evidence: [{ document: "Grant-SOW.pdf", quote: "Unrelated" }],
        sourceTerms: {
          rateCard,
        },
      };

      const result = runPreflight(input);
      assert.equal(result.status, "HOLD");
      const unauthorized = result.findings.find((f) => f.code.startsWith("unauthorized_item"));
      assert.ok(unauthorized);
      assert.ok(unauthorized.message.includes("is not authorized under the campaign SOW rate card"));
    });

    it("blocks made-up item sharing only one common word with SOW item (tight threshold)", () => {
      const input: ReviewInput = {
        vendorName: "Apex Cloud Systems & Studio Lab Inc.",
        buyerName: "Global Emergency Health Corps",
        buyerEmail: "procurement@gehc.org",
        poNumber: "GRANT-RELIEF-2026-MED01",
        currency: "USD",
        items: [
          // "Cloud" is only 1 token shared with "Enterprise Multi-VPC Cloud Architecture"
          { description: "Personal Cloud Backup Subscription", quantity: "1", unitAmount: "120.00" },
        ],
        evidence: [{ document: "Grant-SOW.pdf", quote: "Rate card" }],
        sourceTerms: {
          rateCard,
        },
      };

      const result = runPreflight(input);
      assert.equal(result.status, "HOLD");
      const unauthorized = result.findings.find((f) => f.code.startsWith("unauthorized_item"));
      assert.ok(unauthorized, "Made-up item with 1 shared token must be rejected as unauthorized");
    });
  });

  describe("Step 1: Real Donation Capture & Idempotency", () => {
    it("records, reserves, and completes donation into uncommitted pool", async () => {
      const orderId = `TEST-ORDER-${Date.now()}`;
      await createDonationRecord({
        id: orderId,
        campaignId: "CAMP-MED-01",
        amountMinor: 5000, // $50.00
      });

      const initial = await getDonation(orderId);
      assert.equal(initial?.status, "CREATED");

      // First reservation succeeds
      const reserved = await reserveDonationCapture(orderId);
      assert.equal(reserved, true);

      // Concurrent reservation fails (prevents double-capture)
      const concurrentReserved = await reserveDonationCapture(orderId);
      assert.equal(concurrentReserved, false);

      // Complete capture with verified payment details
      const completed = await completeDonationCapture({
        id: orderId,
        captureId: "CAP-998877",
        payerEmail: "donor@sandbox.com",
        amountMinor: 5000,
      });

      assert.equal(completed.ok, true);
      assert.equal(completed.donation?.status, "COMPLETED");
      assert.equal(completed.donation?.captureId, "CAP-998877");
    });
  });

  describe("Step 2: Atomic Pool Reservation & Vendor Payout Gates", () => {
    it("reserves payout only when campaign pool has sufficient funds and registered vendor", async () => {
      await saveVendor({
        id: "VEND-APEX-01",
        name: "Apex Cloud Systems",
        payoutEmail: "sb-vendor-apex@business.example.com",
      });

      // Campaign initial pool in memory has 0 unless seeded or donated
      // Create and complete a $20,000 donation for CAMP-MED-01
      const donId = `DON-POOL-${Date.now()}`;
      await createDonationRecord({ id: donId, campaignId: "CAMP-MED-01", amountMinor: 2000000 });
      await completeDonationCapture({ id: donId, captureId: "CAP-POOL", amountMinor: 2000000 });

      // Valid reservation ($12,500 <= $20,000)
      const revId1 = `rev_ok_${Date.now()}`;
      await saveReview(revId1, { status: "READY" }, "mockproof1");
      const res1 = await reserveDisbursement({
        id: `DISB-OK-${Date.now()}`,
        campaignId: "CAMP-MED-01",
        vendorId: "VEND-APEX-01",
        reviewId: revId1,
        amountMinor: 1250000, // $12,500.00
        proofHash: "sha256:mockproof1",
      });
      assert.equal(res1.ok, true);

      // Second reservation of $10,000 exceeds remaining $7,500 pool -> Must reject with 409
      const revId2 = `rev_exceed_${Date.now()}`;
      await saveReview(revId2, { status: "READY" }, "mockproof2");
      const res2 = await reserveDisbursement({
        id: `DISB-EXCEED-${Date.now()}`,
        campaignId: "CAMP-MED-01",
        vendorId: "VEND-APEX-01",
        reviewId: revId2,
        amountMinor: 1000000, // $10,000.00 > $7,500 available
        proofHash: "sha256:mockproof2",
      });
      assert.equal(res2.ok, false);
      assert.ok(res2.error?.includes("Insufficient available grant pool"));
    });
  });

  describe("Step 4: Cryptographic Hash Chain & Tamper Detection", () => {
    it("creates sequential linked blocks and verifies clean hash chain", async () => {
      const b1 = await appendLedger("DONATION_COMPLETED", "ORD-1", { amount: 5000 }, "CAMP-MED-01");
      assert.equal(b1.prevHash, "GENESIS");

      const b2 = await appendLedger("DISBURSEMENT_APPROVED", "DISB-1", { amount: 2500 }, "CAMP-MED-01");
      assert.equal(b2.prevHash, b1.entryHash);

      const b3 = await appendLedger("PAYOUT_PAID", "DISB-1", { payoutBatchId: "BAT-1" }, "CAMP-MED-01");
      assert.equal(b3.prevHash, b2.entryHash);

      const verification = await verifyLedgerChain();
      assert.equal(verification.ok, true);
      assert.equal(verification.totalEntries, 3);
      assert.equal(verification.headHash, b3.entryHash);
    });
  });

  describe("Step 5: Campaign-Wide Duplicate Bill Detection & Prevention", () => {
    it("halts agent approval and flags BLOCKING discrepancy on duplicate PO / bill submission", async () => {
      // 1. Seed an active funded donation and prior disbursement for CAMP-MED-01
      const donId = `DON-DUP-${Date.now()}`;
      await createDonationRecord({ id: donId, campaignId: "CAMP-MED-01", amountMinor: 5000000 });
      await completeDonationCapture({ id: donId, captureId: "CAP-DUP", amountMinor: 5000000 });

      await saveVendor({
        id: "VEND-APEX-01",
        name: "Apex Cloud Systems & Studio Lab Inc.",
        payoutEmail: "sb-qb7vt34522927@personal.example.com",
      });

      const priorRevId = `rev_prior_${Date.now()}`;
      await saveReview(priorRevId, { status: "READY" }, "proof_hash_1");
      await reserveDisbursement({
        id: `DISB-FIRST-${Date.now()}`,
        campaignId: "CAMP-MED-01",
        vendorId: "VEND-APEX-01",
        reviewId: priorRevId,
        amountMinor: 250000,
        proofHash: "proof_hash_1",
        poNumber: "PO-DUP-TEST-001",
        docHash: "doc_hash_1",
      });

      // 2. Submit a second bill referencing the EXACT SAME PO in the same campaign
      const duplicateBillInput: ReviewInput = {
        vendorName: "Apex Cloud Systems & Studio Lab Inc.",
        buyerName: "Global Emergency Health Corps",
        buyerEmail: "procurement@gehc.org",
        poNumber: "PO-DUP-TEST-001",
        currency: "USD",
        items: [
          { description: "Enterprise Multi-VPC Cloud Architecture", quantity: "10", unitAmount: "250.00" },
        ],
        evidence: [{ document: "Grant-SOW.pdf", quote: "Duplicate test" }],
        sourceTerms: {
          rateCard: [
            { description: "Enterprise Multi-VPC Cloud Architecture", maxUnitRate: "250.00", maxQuantity: 30 },
          ],
        },
      };

      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            // Agent executes duplicate search across campaign pool
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 60, completionTokens: 25 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_dup_1",
                  toolName: "search_disbursements",
                  args: JSON.stringify({
                    campaignId: "CAMP-MED-01",
                    poNumber: "PO-DUP-TEST-001",
                  }),
                },
              ],
            };
          }
          if (stepCount === 2) {
            // Duplicate detected -> Agent logs blocking discrepancy
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 90, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_disc_1",
                  toolName: "record_discrepancy",
                  args: JSON.stringify({
                    category: "DUPLICATE_BILLING",
                    field: "poNumber",
                    severity: "BLOCKING",
                    description: "Duplicate bill detected in campaign CAMP-MED-01.",
                  }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 110, completionTokens: 40 },
            text: "Duplicate bill identified. Rejection mandatory.",
          };
        },
      });

      const result = await runReconciliationAgent({
        reviewInput: duplicateBillInput,
        model,
      });

      assert.equal(result.status, "DUPLICATE_DETECTED");
      const dupDisc = result.discrepancies.find((d) => d.category === "DUPLICATE_BILLING");
      assert.ok(dupDisc, "DUPLICATE_BILLING discrepancy must be recorded");
      assert.equal(dupDisc.severity, "BLOCKING");
      assert.equal(result.draftInvoiceId, undefined);
    });
  });
});
