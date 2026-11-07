import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { NextRequest } from "next/server";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { POST } from "../src/app/api/paypal/invoices/route";
import {
  toPayPalInvoiceDraft,
  paypalCreateInvoiceSchema,
  formatUnitAmount,
} from "../src/lib/paypal-adapter";
import { runPreflight } from "../src/lib/preflight";
import { sign, newId } from "../src/lib/security";
import {
  ensureSchema,
  saveReview,
  reserveInvoiceDraft,
  releaseInvoiceDraft,
} from "../src/lib/db";
import type { ReviewInput, ReviewResult } from "../src/lib/types";


// Load environment if running in node/tsx
process.loadEnvFile?.(".env.local");

// Offline PayPalAgentToolkit instance for strict parameter schema verification
const toolkit = new PayPalAgentToolkit({
  clientId: "mock-client-id",
  clientSecret: "mock-client-secret",
  configuration: {
    context: { sandbox: true },
    actions: { invoices: { create: true } },
  },
});
const toolkitSchema = toolkit.getTools().create_invoice.parameters;

function createValidInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    vendorName: "Acme Consulting Services",
    buyerName: "Global Logistics Inc",
    buyerEmail: "billing@globallogistics.example.com",
    poNumber: "PO-778899",
    currency: "USD",
    poCap: "5000.00",
    items: [
      {
        description: "Cloud Architecture Advisory",
        quantity: "2",
        unitAmount: "1250.00",
      },
    ],
    evidence: [{ document: "PO-778899.pdf", page: 1, quote: "Advisory rate 1250.00" }],
    ...overrides,
  };
}

describe("Route-Level Adversarial Stress Suite: POST /api/paypal/invoices", () => {
  before(async () => {
    if (process.env.DATABASE_URL) {
      await ensureSchema();
    }
  });

  describe("1. Malformed Request Payloads", () => {
    it("rejects empty JSON object with HTTP 400", async () => {
      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /reviewed invoice and approval are required/i);
    });

    it("rejects payload missing reviewId with HTTP 400", async () => {
      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: JSON.stringify({
          approvalToken: "token-123",
          review: { status: "READY" },
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /reviewed invoice and approval are required/i);
    });

    it("rejects payload missing approvalToken with HTTP 400", async () => {
      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: JSON.stringify({
          reviewId: "rev_123",
          review: { status: "READY" },
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /reviewed invoice and approval are required/i);
    });

    it("rejects payload missing review object with HTTP 400", async () => {
      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: JSON.stringify({
          reviewId: "rev_123",
          approvalToken: "token-123",
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /reviewed invoice and approval are required/i);
    });

    it("handles null body without crashing (catches and returns HTTP 502)", async () => {
      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: "null",
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      // Destructuring null throws TypeError caught by top-level catch
      assert.equal(res.status, 502);
      const data = await res.json();
      assert.ok(data.error);
    });

    it("handles invalid unparseable JSON text without crashing (returns HTTP 502)", async () => {
      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: "NOT_VALID_JSON{abc",
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 502);
      const data = await res.json();
      assert.match(data.error, /JSON/i);
    });
  });

  describe("2. Review Signatures & Anti-Tamper Security Gates", () => {
    it("returns HTTP 404 when reviewId does not exist in database", async () => {
      const nonExistentId = newId("rev_nonexistent");
      const review = runPreflight(createValidInput());
      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: JSON.stringify({
          reviewId: nonExistentId,
          approvalToken: "dummy-token",
          review,
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.match(data.error, /Review expired or was not found/i);
    });

    it("returns HTTP 403 when approvalToken is invalid or corrupted", async () => {
      const reviewId = newId("rev_test_corrupt");
      const review = runPreflight(createValidInput());
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);

      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: JSON.stringify({
          reviewId,
          approvalToken: "corrupted_or_forged_token_aabbcc112233",
          review,
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.match(data.error, /Approval is invalid or stale/i);
    });

    it("returns HTTP 403 when review payload content has been altered (hash mismatch)", async () => {
      const reviewId = newId("rev_test_tampered");
      const review = runPreflight(createValidInput());
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);

      const approvalPayload = JSON.stringify({ reviewId, reviewHash: approvalHash });
      const approvalToken = sign(approvalPayload);

      // Tamper with the review: change vendorName without changing totalMinor
      const tamperedReview: ReviewResult = {
        ...review,
        input: {
          ...review.input,
          vendorName: "Attacker Malicious Corp",
        },
      };

      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: JSON.stringify({
          reviewId,
          approvalToken,
          review: tamperedReview,
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.match(data.error, /Approval is invalid or stale/i);
    });

    it("returns HTTP 409 when review totalMinor has been tampered with", async () => {
      const reviewId = newId("rev_test_amount_tamper");
      const review = runPreflight(createValidInput());
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);

      const approvalPayload = JSON.stringify({ reviewId, reviewHash: approvalHash });
      const approvalToken = sign(approvalPayload);

      // Tamper with totalMinor
      const tamperedReview: ReviewResult = {
        ...review,
        totalMinor: review.totalMinor + 10000,
      };

      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: JSON.stringify({
          reviewId,
          approvalToken,
          review: tamperedReview,
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.match(data.error, /Review is not ready or has changed/i);
    });
  });

  describe("3. Mismatched Review IDs & Cross-Invoice Attacks", () => {
    it("rejects token reuse from a different review (cross-invoice attack)", async () => {
      // Create Review A
      const reviewIdA = newId("rev_cross_a");
      const reviewA = runPreflight(createValidInput({ poNumber: "PO-AAA" }));
      const hashA = sign(JSON.stringify(reviewA));
      await saveReview(reviewIdA, reviewA, hashA);

      // Create Review B
      const reviewIdB = newId("rev_cross_b");
      const reviewB = runPreflight(createValidInput({ poNumber: "PO-BBB" }));
      const hashB = sign(JSON.stringify(reviewB));
      await saveReview(reviewIdB, reviewB, hashB);

      // Legitimate token for Review B
      const tokenB = sign(JSON.stringify({ reviewId: reviewIdB, reviewHash: hashB }));

      // Attacker uses token B and review B against reviewId A
      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: JSON.stringify({
          reviewId: reviewIdA,
          approvalToken: tokenB,
          review: reviewB,
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.match(data.error, /Approval is invalid or stale/i);
    });

    it("rejects token signed for Review A with review content from Review B", async () => {
      const reviewIdA = newId("rev_cross_a2");
      const reviewA = runPreflight(createValidInput({ poNumber: "PO-AAA2" }));
      const hashA = sign(JSON.stringify(reviewA));
      await saveReview(reviewIdA, reviewA, hashA);
      const tokenA = sign(JSON.stringify({ reviewId: reviewIdA, reviewHash: hashA }));

      const reviewB = runPreflight(createValidInput({ poNumber: "PO-BBB2" }));

      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: JSON.stringify({
          reviewId: reviewIdA,
          approvalToken: tokenA,
          review: reviewB,
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.match(data.error, /Approval is invalid or stale/i);
    });
  });

  describe("4. Invalid Review Data & Fail-Fast Reservation Safety", () => {
    it("returns HTTP 409 when review status is HOLD and does NOT reserve draft", async () => {
      const reviewId = newId("rev_hold_status");
      // Input exceeding PO cap triggers HOLD
      const holdInput = createValidInput({ poCap: "100.00" });
      const holdReview = runPreflight(holdInput);
      assert.equal(holdReview.status, "HOLD");

      const approvalHash = sign(JSON.stringify(holdReview));
      await saveReview(reviewId, holdReview, approvalHash);
      const approvalToken = sign(JSON.stringify({ reviewId, reviewHash: approvalHash }));

      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: JSON.stringify({
          reviewId,
          approvalToken,
          review: holdReview,
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.match(data.error, /Review is not ready or has changed/i);

      // Verify no pending reservation was made in database
      const reservation = await reserveInvoiceDraft(reviewId);
      assert.ok(reservation, "Database reservation must NOT have been locked prior to rejection");
      // Clean up reservation
      await releaseInvoiceDraft(reservation);
    });

    it("releases reservation lock if PayPal draft creation fails", async () => {
      const reviewId = newId("rev_paypal_fail_release");
      const review = runPreflight(createValidInput());
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);
      const approvalToken = sign(JSON.stringify({ reviewId, reviewHash: approvalHash }));

      // Force PayPal draft failure to verify rollback
      const savedSecret = process.env.PAYPAL_CLIENT_SECRET;
      process.env.PAYPAL_CLIENT_SECRET = "invalid_secret_for_test";
      try {
        const req = new NextRequest("http://localhost/api/paypal/invoices", {
          method: "POST",
          body: JSON.stringify({
            reviewId,
            approvalToken,
            review,
          }),
          headers: { "content-type": "application/json" },
        });
        const res = await POST(req);
        // Route catches PayPal failure and returns HTTP 502
        assert.equal(res.status, 502);
      } finally {
        process.env.PAYPAL_CLIENT_SECRET = savedSecret;
      }

      // Verify pending reservation was released (lock was NOT leaked)
      const newReservation = await reserveInvoiceDraft(reviewId);
      assert.ok(
        newReservation,
        "Pending reservation must have been released upon PayPal failure, allowing re-reservation"
      );
      await releaseInvoiceDraft(newReservation);
    });
  });

  describe("5. Edge Case Formatting: 50+ Items, Unicode, and Special Characters", () => {
    it("handles exactly 50 line items and passes toolkit schema dual-validation", () => {
      const items50 = Array.from({ length: 50 }, (_, i) => ({
        description: `Consulting Block ${i + 1}`,
        quantity: "1",
        unitAmount: "100.00",
      }));
      const review50 = runPreflight(createValidInput({ items: items50, poCap: "10000.00" }));
      assert.equal(review50.status, "READY");
      assert.equal(review50.totalMinor, 500000);

      const draft = toPayPalInvoiceDraft(review50);
      assert.equal(draft.items.length, 50);

      // Dual validate against local schema and toolkit schema
      const localResult = paypalCreateInvoiceSchema.safeParse(draft);
      assert.equal(localResult.success, true);

      const toolkitResult = toolkitSchema.safeParse(draft);
      assert.equal(toolkitResult.success, true);
    });

    it("preflight holds invoices with >50 items and route returns HTTP 409", async () => {
      const items51 = Array.from({ length: 51 }, (_, i) => ({
        description: `Item ${i + 1}`,
        quantity: "1",
        unitAmount: "10.00",
      }));
      const input51 = createValidInput({ items: items51, poCap: "10000.00" });
      const review51 = runPreflight(input51);
      assert.equal(review51.status, "HOLD");
      assert.ok(review51.findings.some((f) => f.code === "too_many_items"));

      const reviewId = newId("rev_51_items");
      const hash = sign(JSON.stringify(review51));
      await saveReview(reviewId, review51, hash);
      const token = sign(JSON.stringify({ reviewId, reviewHash: hash }));

      const req = new NextRequest("http://localhost/api/paypal/invoices", {
        method: "POST",
        body: JSON.stringify({
          reviewId,
          approvalToken: token,
          review: review51,
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);
      assert.equal(res.status, 409);
    });

    it("adapter directly validates 100 items against toolkit schema", () => {
      const items100 = Array.from({ length: 100 }, (_, i) => ({
        description: `High-Density Service Item ${i + 1}`,
        quantity: "2",
        unitAmount: "15.50",
      }));

      const syntheticReview: ReviewResult = {
        status: "READY",
        totalMinor: 310000,
        findings: [],
        input: createValidInput({ items: items100 }),
      };

      const draft = toPayPalInvoiceDraft(syntheticReview);
      assert.equal(draft.items.length, 100);

      const toolkitResult = toolkitSchema.safeParse(draft);
      assert.equal(toolkitResult.success, true);
      assert.equal(draft.items[0].unit_amount.value, "15.50");
    });

    it("handles unusual characters, quotes, XSS/SQL injection patterns, and control characters in descriptions and references", () => {
      const unusualDescriptions = [
        `Double "quotes" and Single 'quotes' and Backticks \`echo test\``,
        `<script>alert("XSS")</script><img src=x onerror=alert(1)>`,
        `'; DROP TABLE invoice_reviews; SELECT * FROM users WHERE '1'='1`,
        `Path/Traversal/../../../../etc/shadow & calc.exe | rm -rf /`,
        `Line 1\nLine 2\r\nLine 3 with\ttabs and   spaces`,
        `HTML Entities &amp; &lt; &gt; &quot; &#39;`,
        `Special symbols !@#$%^&*()_+-=[]{}|;':",.<>?/~`,
      ];

      const items = unusualDescriptions.map((desc) => ({
        description: desc,
        quantity: "1",
        unitAmount: "25.00",
      }));

      const review = runPreflight(
        createValidInput({
          poNumber: `PO-REF/2026#001;SELECT*FROM "orders"`,
          items,
        })
      );
      assert.equal(review.status, "READY");

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.reference, `PO-REF/2026#001;SELECT*FROM "orders"`);
      assert.equal(draft.items.length, unusualDescriptions.length);

      // Verify toolkit accepts every unusual item description
      const toolkitResult = toolkitSchema.safeParse(draft);
      assert.equal(toolkitResult.success, true);
    });

    it("handles multilingual Unicode vendor and buyer names across scripts", () => {
      const unicodeCases = [
        {
          lang: "Cyrillic (Russian)",
          vendor: `ООО "Технологии Будущего & Партнеры"`,
          buyer: `ЗАО "Северсталь Инвест"`,
        },
        {
          lang: "Japanese (Kanji & Kana)",
          vendor: "株式会社サンライズテクノロジー",
          buyer: "ソニーグループ株式会社",
        },
        {
          lang: "Chinese Simplified",
          vendor: "北京智能创新科技有限公司",
          buyer: "上海浦东国际贸易有限公司",
        },
        {
          lang: "Arabic (RTL)",
          vendor: "شركة النور للتجارة الدولية ذ.م.م",
          buyer: "مؤسسة الرياض للخدمات التقنية",
        },
        {
          lang: "German (Umlauts & Eszett)",
          vendor: "Müller & Söhne Präzisionswerkzeuge GmbH & Co. KG",
          buyer: "Großmann & Weiß Straßenbau AG",
        },
        {
          lang: "French (Accents & Ligatures)",
          vendor: "Société d'Électricité Générale & Frères S.A.S.",
          buyer: "Compagnie Française des Énergies Nouvelles",
        },
        {
          lang: "Emojis & Symbols",
          vendor: "🚀 ACME HyperTech 🌟 (Vendor #1) 🤖",
          buyer: "Global ✨ Ventures 🌍 LLC",
        },
      ];

      for (const { lang, vendor, buyer } of unicodeCases) {
        const review = runPreflight(
          createValidInput({
            vendorName: vendor,
            buyerName: buyer,
            buyerEmail: "test-unicode@example.com",
          })
        );
        assert.equal(review.status, "READY", `Preflight must pass for ${lang}`);

        const draft = toPayPalInvoiceDraft(review);
        assert.equal(
          draft.invoicer_business_name,
          vendor.slice(0, 300),
          `Invoicer business name must preserve ${lang}`
        );
        assert.equal(
          draft.invoicer_given_name,
          vendor.slice(0, 140),
          `Invoicer given name must preserve ${lang}`
        );
        assert.equal(
          draft.primary_recipients[0].billing_info?.business_name,
          buyer.slice(0, 300),
          `Buyer business name must preserve ${lang}`
        );

        const toolkitResult = toolkitSchema.safeParse(draft);
        assert.equal(
          toolkitResult.success,
          true,
          `Toolkit schema must accept ${lang}: ${toolkitResult.error?.message}`
        );
      }
    });

    it("verifies formatUnitAmount normalization on diverse numeric inputs", () => {
      assert.equal(formatUnitAmount("0"), "0.00");
      assert.equal(formatUnitAmount("0.0"), "0.00");
      assert.equal(formatUnitAmount("0.00"), "0.00");
      assert.equal(formatUnitAmount("10"), "10.00");
      assert.equal(formatUnitAmount("10.5"), "10.50");
      assert.equal(formatUnitAmount("10.99"), "10.99");
      assert.equal(formatUnitAmount(250), "250.00");
      assert.equal(formatUnitAmount(250.5), "250.50");
      assert.equal(formatUnitAmount("  99.9  "), "99.90");
      assert.equal(formatUnitAmount("1000000.00"), "1000000.00");
    });
  });
});
