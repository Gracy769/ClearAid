import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { NextRequest } from "next/server";
import { POST as createOrderRoute } from "../src/app/api/paypal/orders/route";
import { POST as captureOrderRoute } from "../src/app/api/paypal/orders/[id]/capture/route";
import { runPreflight } from "../src/lib/preflight";
import { sign, newId } from "../src/lib/security";
import { saveReview, savePaypalOrder } from "../src/lib/db";
import { setPayPalOrderMocks, resetPayPalOrderMocks } from "../src/lib/paypal";
import type { ReviewInput, ReviewResult } from "../src/lib/types";

// Load test environment (guarded so tests pass on fresh clone without .env.local)
try {
  process.loadEnvFile?.(".env.local");
} catch {
  // Fallback for fresh clone / CI
}
process.env.APP_SECRET = process.env.APP_SECRET || "4965d070531229cafc88f882e68af6c6ac0ebe03720a2b09fcdd662adb8479c6";
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || "mock-admin-token";

function createValidInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    vendorName: "Apex Digital Solutions",
    buyerName: "Vanguard Enterprises",
    buyerEmail: "payables@vanguard.example.com",
    poNumber: "PO-ORD-2026",
    currency: "USD",
    poCap: "5000.00",
    items: [
      {
        description: "Cloud Security Audit Milestone 1",
        quantity: "2",
        unitAmount: "1250.00",
      },
    ],
    evidence: [
      {
        document: "PO-ORD-2026.pdf",
        page: 1,
        quote: "Milestone 1 rate $1250.00 authorized",
      },
    ],
    documentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ...overrides,
  };
}

describe("Empirical Challenger M3.1: Orders v2 Checkout & Settlement Stress Suite", () => {
  beforeEach(() => {
    resetPayPalOrderMocks();
  });

  afterEach(() => {
    resetPayPalOrderMocks();
  });

  // =========================================================================
  // 1. Currency Gate Tests (EUR, GBP, JPY, and other non-USD currencies)
  // =========================================================================
  describe("1. Currency Gate Stress Tests (Non-USD Rejections)", () => {
    const nonUsdCurrencies = ["EUR", "GBP", "JPY", "eur", "gbp", "jpy", "AUD", "CAD", "CHF"];

    for (const cur of nonUsdCurrencies) {
      it(`rejects non-USD currency '${cur}' with HTTP 400`, async () => {
        const reviewId = newId(`rev_cur_${cur.toLowerCase()}`);
        const input = createValidInput({ currency: cur });
        const review: ReviewResult = {
          status: "READY",
          input,
          findings: [],
          totalMinor: 250000,
        };
        const approvalHash = sign(JSON.stringify(review));
        await saveReview(reviewId, review, approvalHash);

        const req = new NextRequest("http://localhost:3000/api/paypal/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviewId }),
        });

        const res = await createOrderRoute(req);
        assert.equal(res.status, 400, `Expected HTTP 400 for non-USD currency '${cur}', got ${res.status}`);
        const json = await res.json();
        assert.match(json.error, /USD settlement/i);
      });
    }
  });

  // =========================================================================
  // 2. Malformed Order IDs in Capture Route
  // =========================================================================
  describe("2. Malformed Order ID Format Validation", () => {
    const malformedIds = [
      "!@#$%^&*",
      "invalid_symbols!@#",
      "5o190127tn364715c", // lowercase
      "5O190127TN36471", // 15 chars (< 17)
      "5O190127TN364715C123456789012345678", // 35 chars (> 32)
      "ORDER-WITH-DASHES-12345",
      "   5O190127TN364715C   ",
      "'; DROP TABLE paypal_orders; --",
      "<script>alert(1)</script>",
      "",
    ];

    for (const malformedId of malformedIds) {
      it(`rejects malformed Order ID '${malformedId}' with HTTP 400 without crashing`, async () => {
        const req = new NextRequest(`http://localhost:3000/api/paypal/orders/${encodeURIComponent(malformedId)}/capture`, {
          method: "POST",
        });

        const res = await captureOrderRoute(req, {
          params: Promise.resolve({ id: malformedId }),
        });

        assert.equal(res.status, 400, `Expected HTTP 400 for malformed ID '${malformedId}', got ${res.status}`);
        const json = await res.json();
        assert.match(json.error, /Invalid PayPal Order ID format/i);
      });
    }
  });

  // =========================================================================
  // 3. Unapproved & HOLD Reviews in Order Creation
  // =========================================================================
  describe("3. Preflight Review Status Enforcements (HOLD / Unapproved)", () => {
    it("rejects review with HOLD status with HTTP 409", async () => {
      const reviewId = newId("rev_adv_hold");
      const input = createValidInput({
        poCap: "1000.00",
        items: [{ description: "Exceeds cap", quantity: "1", unitAmount: "2500.00" }],
      });
      const review = runPreflight(input);
      assert.equal(review.status, "HOLD");
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);

      const req = new NextRequest("http://localhost:3000/api/paypal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId }),
      });

      const res = await createOrderRoute(req);
      assert.equal(res.status, 409);
      const json = await res.json();
      assert.match(json.error, /HOLD|not ready/i);
    });

    it("rejects review with blocking findings even if status is READY with HTTP 409", async () => {
      const reviewId = newId("rev_adv_block");
      const input = createValidInput();
      const review: ReviewResult = {
        status: "READY",
        input,
        findings: [
          {
            field: "poCap",
            message: "Forced blocking finding for stress testing",
            severity: "block",
          },
        ],
        totalMinor: 250000,
      };
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);

      const req = new NextRequest("http://localhost:3000/api/paypal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId }),
      });

      const res = await createOrderRoute(req);
      assert.equal(res.status, 409);
      const json = await res.json();
      assert.match(json.error, /HOLD|not ready/i);
    });
  });

  // =========================================================================
  // 4. Concurrency & Race Conditions on Duplicate Capture (Double-Spend)
  // =========================================================================
  describe("4. Concurrency Guard on Duplicate / Parallel Capture", () => {
    it("handles parallel capture calls: only 1 succeeds (200), second returns HTTP 409 (DB Mode)", async () => {
      const orderId = "5O190127TN364715R";
      const reviewId = newId("rev_parallel_capture");
      const input = createValidInput();
      const review = runPreflight(input);
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);
      await savePaypalOrder(orderId, reviewId, "CREATED");

      let captureCount = 0;
      setPayPalOrderMocks({
        captureOrder: async () => {
          captureCount++;
          // Simulate realistic PayPal API network latency of 1200ms
          await new Promise((resolve) => setTimeout(resolve, 1200));
          return {
            status: "success",
            response: {
              id: orderId,
              status: "COMPLETED",
              purchase_units: [
                {
                  reference_id: "default",
                  payments: {
                    captures: [
                      {
                        id: `CAP-PARALLEL-${captureCount}`,
                        status: "COMPLETED",
                        amount: { currency_code: "USD", value: "2500.00" },
                        final_capture: true,
                      },
                    ],
                  },
                },
              ],
            },
          };
        },
      });

      const req1 = new NextRequest(`http://localhost:3000/api/paypal/orders/${orderId}/capture`, {
        method: "POST",
      });
      const req2 = new NextRequest(`http://localhost:3000/api/paypal/orders/${orderId}/capture`, {
        method: "POST",
      });

      // Dispatch 2 capture calls simultaneously in parallel
      const [res1, res2] = await Promise.all([
        captureOrderRoute(req1, { params: Promise.resolve({ id: orderId }) }),
        captureOrderRoute(req2, { params: Promise.resolve({ id: orderId }) }),
      ]);

      const res1Json = await res1.json();
      const res2Json = await res2.json();
      console.log(`Parallel capture result (DB):`, {
        res1: { status: res1.status, body: res1Json },
        res2: { status: res2.status, body: res2Json },
        captureCount,
      });

      const statuses = [res1.status, res2.status].sort();

      // Exactly one must be 200, one must be 409
      assert.deepEqual(
        statuses,
        [200, 409],
        `Expected exactly one 200 and one 409, but got [${res1.status}, ${res2.status}]. Double-spend detected!`
      );
    });

    it("handles parallel capture calls in in-memory mode: only 1 succeeds (200), second returns HTTP 409", async () => {
      const savedDbUrl = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;

      try {
        const orderId = "5O190127TN364715M";
        const reviewId = newId("rev_parallel_mem");
        const input = createValidInput();
        const review = runPreflight(input);
        const approvalHash = sign(JSON.stringify(review));
        await saveReview(reviewId, review, approvalHash);
        await savePaypalOrder(orderId, reviewId, "CREATED");

        let captureCount = 0;
        setPayPalOrderMocks({
          captureOrder: async () => {
            captureCount++;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
              status: "success",
              response: {
                id: orderId,
                status: "COMPLETED",
                purchase_units: [
                  {
                    reference_id: "default",
                    payments: {
                      captures: [
                        {
                          id: `CAP-PARALLEL-MEM-${captureCount}`,
                          status: "COMPLETED",
                          amount: { currency_code: "USD", value: "2500.00" },
                          final_capture: true,
                        },
                      ],
                    },
                  },
                ],
              },
            };
          },
        });

        const req1 = new NextRequest(`http://localhost:3000/api/paypal/orders/${orderId}/capture`, {
          method: "POST",
        });
        const req2 = new NextRequest(`http://localhost:3000/api/paypal/orders/${orderId}/capture`, {
          method: "POST",
        });

        const [res1, res2] = await Promise.all([
          captureOrderRoute(req1, { params: Promise.resolve({ id: orderId }) }),
          captureOrderRoute(req2, { params: Promise.resolve({ id: orderId }) }),
        ]);

        const res1Json = await res1.json();
        const res2Json = await res2.json();
        console.log(`Parallel capture result (MEM):`, {
          res1: { status: res1.status, body: res1Json },
          res2: { status: res2.status, body: res2Json },
          captureCount,
        });

        const statuses = [res1.status, res2.status].sort();

        assert.deepEqual(
          statuses,
          [200, 409],
          `Expected exactly one 200 and one 409 in in-memory mode, but got [${res1.status}, ${res2.status}]. Double-spend detected!`
        );
      } finally {
        process.env.DATABASE_URL = savedDbUrl;
      }
    });
  });
});
