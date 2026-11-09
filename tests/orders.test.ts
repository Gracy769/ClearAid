import assert from "node:assert/strict";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import { NextRequest } from "next/server";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { POST as createOrderRoute } from "../src/app/api/paypal/orders/route";
import { POST as captureOrderRoute } from "../src/app/api/paypal/orders/[id]/capture/route";
import { runPreflight } from "../src/lib/preflight";
import { sign, newId } from "../src/lib/security";
import {
  saveReview,
  getReview,
  getPaypalOrder,
  savePaypalOrder,
  ensureSchema,
} from "../src/lib/db";
import {
  setPayPalOrderMocks,
  resetPayPalOrderMocks,
} from "../src/lib/paypal";
import type { ReviewInput, ReviewResult } from "../src/lib/types";

// Load environment for local test execution (guarded so tests pass on fresh clone without .env.local)
try {
  process.loadEnvFile?.(".env.local");
} catch {
  // Fallback for fresh clone / CI
}
process.env.APP_SECRET = process.env.APP_SECRET || "4965d070531229cafc88f882e68af6c6ac0ebe03720a2b09fcdd662adb8479c6";
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || "mock-admin-token";

// Initialize offline toolkit to inspect schema contracts
const toolkit = new PayPalAgentToolkit({
  clientId: "mock-client-id",
  clientSecret: "mock-client-secret",
  configuration: {
    context: { sandbox: true },
    actions: {
      orders: { create: true, get: true, capture: true },
    },
  },
});
const toolkitTools = toolkit.getTools();
const createOrderSchema = toolkitTools.create_order.parameters;

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
      {
        description: "Infrastructure Pen-Testing",
        quantity: "1",
        unitAmount: "500.00",
      },
    ],
    evidence: [
      {
        document: "PO-ORD-2026.pdf",
        page: 1,
        quote: "Milestone 1 rate $1250.00, Pen-Testing $500.00 authorized",
      },
    ],
    documentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ...overrides,
  };
}

describe("Orders v2 Checkout & Settlement Test Suite", () => {
  before(async () => {
    if (process.env.DATABASE_URL) {
      await ensureSchema().catch(() => {});
    }
  });

  beforeEach(() => {
    resetPayPalOrderMocks();
  });

  afterEach(() => {
    resetPayPalOrderMocks();
  });

  // =========================================================================
  // 1. Order Creation Scenarios
  // =========================================================================
  describe("1. Order Creation (POST /api/paypal/orders)", () => {
    it("creates an order successfully for a READY review (Happy Path)", async () => {
      const reviewId = newId("rev_order_valid");
      const input = createValidInput();
      const review = runPreflight(input);
      assert.equal(review.status, "READY");

      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);

      let capturedPayload: Record<string, unknown> | null = null;
      setPayPalOrderMocks({
        createOrder: async (payload) => {
          capturedPayload = payload;
          return {
            id: "5O190127TN364715T",
            status: "CREATED",
            links: [
              {
                rel: "approve",
                href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
                method: "GET",
              },
              {
                rel: "capture",
                href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T/capture",
                method: "POST",
              },
            ],
          };
        },
      });

      const req = new NextRequest("http://localhost:3000/api/paypal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId }),
      });

      const res = await createOrderRoute(req);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.orderId, "5O190127TN364715T");
      assert.equal(json.status, "CREATED");
      assert.match(json.approvalUrl, /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);

      // Verify toolkit schema compliance of the generated payload
      assert(capturedPayload, "Payload should have been passed to toolkit");
      const validated = createOrderSchema.safeParse(capturedPayload);
      assert.equal(validated.success, true, "Payload must strictly conform to create_order schema");

      // Verify numeric item mapping
      const items = (capturedPayload.items as Array<Record<string, unknown>>) || [];
      assert.equal(capturedPayload.currencyCode, "USD");
      assert.equal(items.length, 2);
      assert.equal(items[0].itemCost, 1250);
      assert.equal(items[0].quantity, 2);
      assert.equal(items[0].itemTotal, 2500);

      // Verify order record was persisted in database
      const storedOrder = await getPaypalOrder("5O190127TN364715T");
      assert(storedOrder, "Order should be saved in database");
      assert.equal(storedOrder.review_id, reviewId);
      assert.equal(storedOrder.status, "CREATED");
    });

    it("rejects request missing reviewId with HTTP 400", async () => {
      const req = new NextRequest("http://localhost:3000/api/paypal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const res = await createOrderRoute(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /reviewId is required/i);
    });

    it("rejects non-existent reviewId with HTTP 404", async () => {
      const req = new NextRequest("http://localhost:3000/api/paypal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId: "rev_non_existent_404" }),
      });

      const res = await createOrderRoute(req);
      assert.equal(res.status, 404);
      const json = await res.json();
      assert.match(json.error, /Review not found/i);
    });

    it("rejects review with HOLD status with HTTP 409", async () => {
      const reviewId = newId("rev_order_hold");
      // Create input that exceeds PO cap
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
      assert.match(json.error, /HOLD/i);
    });

    it("rejects non-USD currency with HTTP 400", async () => {
      const reviewId = newId("rev_order_eur");
      const input = createValidInput({
        currency: "EUR",
        poCap: "5000.00",
      });
      // Force status READY for testing currency gate
      const review: ReviewResult = {
        status: "READY",
        input,
        findings: [],
        totalMinor: 300000,
      };

      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);

      const req = new NextRequest("http://localhost:3000/api/paypal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId }),
      });

      const res = await createOrderRoute(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /USD settlement/i);
    });

    it("rejects review with empty line items with HTTP 400", async () => {
      const reviewId = newId("rev_order_empty_items");
      const input = createValidInput({ items: [] });
      const review: ReviewResult = {
        status: "READY",
        input,
        findings: [],
        totalMinor: 0,
      };

      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);

      const req = new NextRequest("http://localhost:3000/api/paypal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId }),
      });

      const res = await createOrderRoute(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /at least one line item/i);
    });
  });

  // =========================================================================
  // 2. Order Capture Scenarios
  // =========================================================================
  describe("2. Order Capture (POST /api/paypal/orders/[id]/capture)", () => {
    it("captures an order, records captureId, and transitions review to PAID (Happy Path)", async () => {
      const reviewId = newId("rev_order_capture");
      const orderId = "5O190127TN364715C";
      const captureId = "3C679366HH2525463";

      const input = createValidInput();
      const review = runPreflight(input);
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);
      await savePaypalOrder(orderId, reviewId, "CREATED");

      setPayPalOrderMocks({
        captureOrder: async (id) => {
          assert.equal(id, orderId);
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
                        id: captureId,
                        status: "COMPLETED",
                        amount: { currency_code: "USD", value: "3000.00" },
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

      const req = new NextRequest(`http://localhost:3000/api/paypal/orders/${orderId}/capture`, {
        method: "POST",
      });

      const res = await captureOrderRoute(req, {
        params: Promise.resolve({ id: orderId }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.orderId, orderId);
      assert.equal(json.status, "COMPLETED");
      assert.equal(json.captureId, captureId);

      // Verify order updated in DB
      const updatedOrder = await getPaypalOrder(orderId);
      assert.equal(updatedOrder?.status, "COMPLETED");
      assert.equal(updatedOrder?.capture_id, captureId);

      // Verify review updated to PAID
      const updatedReview = await getReview(reviewId);
      const rev = updatedReview?.review as ReviewResult | undefined;
      assert.equal(rev?.status, "PAID");
    });

    it("rejects invalid Order ID format with HTTP 400", async () => {
      const req = new NextRequest("http://localhost:3000/api/paypal/orders/INVALID/capture", {
        method: "POST",
      });

      const res = await captureOrderRoute(req, {
        params: Promise.resolve({ id: "INVALID" }),
      });

      assert.equal(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /Invalid PayPal Order ID format/i);
    });

    it("rejects duplicate capture attempts on already COMPLETED order with HTTP 409", async () => {
      const orderId = "5O190127TN364715X";
      const captureId = "3C679366HH2525499";
      const reviewId = newId("rev_order_completed");

      await savePaypalOrder(orderId, reviewId, "COMPLETED", captureId);

      const req = new NextRequest(`http://localhost:3000/api/paypal/orders/${orderId}/capture`, {
        method: "POST",
      });

      const res = await captureOrderRoute(req, {
        params: Promise.resolve({ id: orderId }),
      });

      assert.equal(res.status, 409);
      const json = await res.json();
      assert.match(json.error, /already captured/i);
      assert.equal(json.captureId, captureId);
    });

    it("handles PayPal capture failure and returns HTTP 502", async () => {
      const orderId = "5O190127TN364715F";
      const reviewId = newId("rev_order_fail");
      await savePaypalOrder(orderId, reviewId, "CREATED");

      setPayPalOrderMocks({
        captureOrder: async () => ({
          status: "error",
          response: {
            message: "INSTRUMENT_DECLINED",
          },
        }),
      });

      const req = new NextRequest(`http://localhost:3000/api/paypal/orders/${orderId}/capture`, {
        method: "POST",
      });

      const res = await captureOrderRoute(req, {
        params: Promise.resolve({ id: orderId }),
      });

      assert.equal(res.status, 502);
      const json = await res.json();
      assert.match(json.error, /INSTRUMENT_DECLINED|failed/i);
    });
  });
});
