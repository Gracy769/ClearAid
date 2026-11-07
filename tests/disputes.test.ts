import assert from "node:assert/strict";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import { NextRequest } from "next/server";
import { POST as webhookRoute } from "../src/app/api/paypal/webhooks/invoicing/route";
import {
  getPayPalAccessToken,
  _resetPayPalTokenCache,
  _getPayPalTokenCacheStatus,
} from "../src/lib/paypal";
import {
  assembleDisputeEvidencePackage,
  verifyEvidencePackageIntegrity,
  registerMemoryReview,
  clearMemoryReviews,
  type PayPalDisputeEvent,
} from "../src/lib/dispute";
import { runPreflight } from "../src/lib/preflight";
import { sign } from "../src/lib/security";
import { saveReview, ensureSchema } from "../src/lib/db";
import type { ReviewInput, ReviewResult } from "../src/lib/types";

// Load test environment
process.loadEnvFile?.(".env.local");

// Preserve global fetch
const originalFetch = globalThis.fetch;

function createValidInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    vendorName: "Starlight Digital Consulting",
    buyerName: "Enterprise Global Corp",
    buyerEmail: "procurement@enterpriseglobal.example.com",
    poNumber: "PO-DISPUTE-8899",
    currency: "USD",
    poCap: "3500.00",
    items: [
      {
        description: "Cloud Architecture Delivery Phase 1",
        quantity: "2",
        unitAmount: "1250.00",
      },
      {
        description: "Security Penetration Testing",
        quantity: "1",
        unitAmount: "750.00",
      },
    ],
    evidence: [
      {
        document: "SOW-8899.pdf",
        page: 2,
        quote: "Cloud Architecture rate $1250.00, Pen-Testing $750.00 approved",
      },
      {
        document: "DELIVERY-RECEIPT.pdf",
        page: 1,
        quote: "Deliverables received and verified by Enterprise Global Corp engineering",
      },
    ],
    documentHash: "b4c5d6e7f8091a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b",
    ...overrides,
  };
}

function createSyntheticDisputeEvent(
  overrides: Partial<PayPalDisputeEvent> = {},
  txnOverrides: Record<string, unknown> = {}
): PayPalDisputeEvent {
  return {
    id: `WH-EVT-DISPUTE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: "dispute",
    event_type: "CUSTOMER.DISPUTE.CREATED",
    summary: "Buyer opened dispute for merchandise not received",
    resource: {
      dispute_id: "PP-D-882299",
      create_time: new Date().toISOString(),
      disputed_transactions: [
        {
          seller_transaction_id: "TXN-SEL-882299",
          buyer_transaction_id: "TXN-BUY-882299",
          invoice_number: "PO-DISPUTE-8899",
          custom: "rev_test_dispute_custom_id",
          gross_amount: { currency_code: "USD", value: "3250.00" },
          buyer: { name: "Enterprise Global Corp" },
          seller: { name: "Starlight Digital Consulting" },
          ...txnOverrides,
        },
      ],
      dispute_amount: { currency_code: "USD", value: "3250.00" },
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      status: "UNDER_REVIEW",
      dispute_state: "REQUIRED_ACTION",
      buyer_response_due_date: "2026-11-20T12:00:00Z",
    },
    ...overrides,
  };
}

describe("Milestone 3 Dispute Webhook & Token Cache Test Suite", () => {
  before(async () => {
    if (process.env.DATABASE_URL) {
      await ensureSchema().catch(() => {});
    }
  });

  beforeEach(() => {
    _resetPayPalTokenCache();
    clearMemoryReviews();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    _resetPayPalTokenCache();
    clearMemoryReviews();
    globalThis.fetch = originalFetch;
  });

  // =========================================================================
  // 1. In-Memory OAuth Token Caching & TTL Management
  // =========================================================================
  describe("1. OAuth Token In-Memory TTL Caching", () => {
    it("fetches token on first request and returns cached token on subsequent calls within TTL", async () => {
      let fetchCalls = 0;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          fetchCalls++;
          return new Response(
            JSON.stringify({
              access_token: "mock-cached-access-token-xyz",
              token_type: "Bearer",
              expires_in: 3600, // 1 hour
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return originalFetch(url, init);
      };

      // Ensure credentials exist for the function
      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      // Call 1: should trigger network fetch
      const token1 = await getPayPalAccessToken();
      assert.equal(token1, "mock-cached-access-token-xyz");
      assert.equal(fetchCalls, 1);

      const cacheStatus = _getPayPalTokenCacheStatus();
      assert.equal(cacheStatus.cached, true);
      assert(cacheStatus.expiresInMs > 0);

      // Call 2: within TTL, should hit cache without network fetch
      const token2 = await getPayPalAccessToken();
      assert.equal(token2, "mock-cached-access-token-xyz");
      assert.equal(fetchCalls, 1, "Subsequent call within TTL must not make network request");

      // Call 3 with forceRefresh: should bypass cache
      const token3 = await getPayPalAccessToken({ forceRefresh: true });
      assert.equal(token3, "mock-cached-access-token-xyz");
      assert.equal(fetchCalls, 2, "Force refresh must fetch new token");
    });

    it("deduplicates concurrent in-flight token requests (Thundering Herd Protection)", async () => {
      let fetchCalls = 0;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          fetchCalls++;
          // Simulate latency
          await new Promise((resolve) => setTimeout(resolve, 50));
          return new Response(
            JSON.stringify({
              access_token: "mock-concurrent-token-abc",
              expires_in: 1800,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return originalFetch(url, init);
      };

      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      // Dispatch 5 concurrent requests simultaneously
      const results = await Promise.all([
        getPayPalAccessToken(),
        getPayPalAccessToken(),
        getPayPalAccessToken(),
        getPayPalAccessToken(),
        getPayPalAccessToken(),
      ]);

      assert.equal(results.length, 5);
      for (const token of results) {
        assert.equal(token, "mock-concurrent-token-abc");
      }
      assert.equal(fetchCalls, 1, "Concurrent calls must share single in-flight promise");
    });
  });

  // =========================================================================
  // 2. Webhook Signature Headers & Verification Gates
  // =========================================================================
  describe("2. Webhook Signature Gates & Pre-Validation", () => {
    it("returns HTTP 400 when required PayPal signature headers are missing", async () => {
      process.env.PAYPAL_WEBHOOK_ID = "mock-webhook-id";
      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      const event = createSyntheticDisputeEvent();
      const req = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Missing paypal-auth-algo, paypal-cert-url, etc.
        },
        body: JSON.stringify(event),
      });

      const res = await webhookRoute(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /Missing required PayPal signature headers/i);
    });

    it("returns HTTP 400 when body payload is invalid JSON", async () => {
      process.env.PAYPAL_WEBHOOK_ID = "mock-webhook-id";
      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      const req = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          "paypal-transmission-id": "trans-123",
          "paypal-transmission-sig": "sig-123",
          "paypal-transmission-time": "2026-11-07T09:00:00Z",
        },
        body: "NOT_VALID_JSON{abc",
      });

      const res = await webhookRoute(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /Invalid JSON/i);
    });

    it("returns HTTP 401 when PayPal webhook signature verification fails", async () => {
      process.env.PAYPAL_WEBHOOK_ID = "mock-webhook-id";
      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "mock-token", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (urlStr.includes("/v1/notifications/verify-webhook-signature")) {
          return new Response(
            JSON.stringify({ verification_status: "FAILURE" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      const event = createSyntheticDisputeEvent();
      const req = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          "paypal-transmission-id": "trans-forged",
          "paypal-transmission-sig": "forged-signature-base64",
          "paypal-transmission-time": "2026-11-07T09:00:00Z",
        },
        body: JSON.stringify(event),
      });

      const res = await webhookRoute(req);
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.match(json.error, /Invalid webhook signature/i);
    });
  });

  // =========================================================================
  // 3. Dispute Webhook Event Processing (CUSTOMER.DISPUTE.*)
  // =========================================================================
  describe("3. Dispute Webhook Processing & Evidence Compilation", () => {
    it("processes CUSTOMER.DISPUTE.CREATED and returns assembled evidence package (Happy Path)", async () => {
      process.env.PAYPAL_WEBHOOK_ID = "mock-webhook-id";
      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      // Register review in memory and DB
      const reviewId = "rev_dispute_happy_path";
      const input = createValidInput({ poNumber: "PO-DISPUTE-8899" });
      const review = runPreflight(input);
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);
      registerMemoryReview(reviewId, { review, approval_hash: approvalHash });

      // Mock successful signature verification
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "mock-valid-token", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (urlStr.includes("/v1/notifications/verify-webhook-signature")) {
          return new Response(
            JSON.stringify({ verification_status: "SUCCESS" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      const event = createSyntheticDisputeEvent(
        { event_type: "CUSTOMER.DISPUTE.CREATED" },
        { custom: reviewId, invoice_number: "PO-DISPUTE-8899" }
      );

      const req = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          "paypal-transmission-id": "trans-valid-1",
          "paypal-transmission-sig": "valid-signature",
          "paypal-transmission-time": "2026-11-07T09:00:00Z",
        },
        body: JSON.stringify(event),
      });

      const res = await webhookRoute(req);
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.received, true);
      assert.equal(json.eventType, "CUSTOMER.DISPUTE.CREATED");
      assert.equal(json.disputeId, "PP-D-882299");

      // Verify evidence package structure
      const pkg = json.evidencePackage;
      assert(pkg, "Evidence package must be returned");
      assert.equal(pkg.status, "ASSEMBLED");
      assert.equal(pkg.reviewId, reviewId);
      assert.equal(pkg.vendorName, "Starlight Digital Consulting");
      assert.equal(pkg.buyerName, "Enterprise Global Corp");
      assert.equal(pkg.poNumber, "PO-DISPUTE-8899");
      assert.equal(pkg.currency, "USD");
      assert.equal(pkg.authorizedTotal, "USD 3250.00");

      // Verify evidence documents and itemized proofs
      assert.equal(pkg.evidenceDocuments.length, 2);
      assert.equal(pkg.evidenceDocuments[0].documentName, "SOW-8899.pdf");
      assert.equal(pkg.evidenceDocuments[0].page, 2);
      assert.match(pkg.evidenceDocuments[0].quote, /Architecture rate \$1250\.00/);

      assert.equal(pkg.itemizedProofs.length, 2);
      assert.equal(pkg.itemizedProofs[0].totalAmount, "2500.00");
      assert.equal(pkg.itemizedProofs[1].totalAmount, "750.00");

      // Verify cryptographic integrity
      assert(pkg.verificationHash, "Must compute verificationHash");
      assert(pkg.hmacSignature, "Must compute HMAC signature");

      const isValid = verifyEvidencePackageIntegrity(pkg, review);
      assert.equal(isValid, true, "Package signature and canonical hash must verify");
    });

    it("processes CUSTOMER.DISPUTE.RESOLVED and updates dispute state", async () => {
      process.env.PAYPAL_WEBHOOK_ID = "mock-webhook-id";
      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "mock-valid-token", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (urlStr.includes("/v1/notifications/verify-webhook-signature")) {
          return new Response(
            JSON.stringify({ verification_status: "SUCCESS" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      const event = createSyntheticDisputeEvent({
        event_type: "CUSTOMER.DISPUTE.RESOLVED",
        resource: {
          dispute_id: "PP-D-882299",
          status: "RESOLVED",
          dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" },
        },
      });

      const req = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          "paypal-transmission-id": `trans-resolved-${Date.now()}`,
          "paypal-transmission-sig": "valid-sig",
          "paypal-transmission-time": "2026-11-07T09:00:00Z",
        },
        body: JSON.stringify(event),
      });

      const res = await webhookRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.received, true);
      assert.equal(json.eventType, "CUSTOMER.DISPUTE.RESOLVED");
      assert.equal(json.status, "RESOLVED");
    });
  });

  // =========================================================================
  // 4. Cryptographic Anti-Tamper & Verification Invariants
  // =========================================================================
  describe("4. Cryptographic Anti-Tamper Verification Invariants", () => {
    it("fails verification when line items have been tampered with", async () => {
      const reviewId = "rev_tamper_items";
      const input = createValidInput();
      const review = runPreflight(input);
      const approvalHash = sign(JSON.stringify(review));
      registerMemoryReview(reviewId, { review, approval_hash: approvalHash });

      const event = createSyntheticDisputeEvent(
        { event_type: "CUSTOMER.DISPUTE.CREATED" },
        { custom: reviewId }
      );

      const pkg = await assembleDisputeEvidencePackage(event);
      assert.equal(pkg.status, "ASSEMBLED");

      // Verify genuine review matches
      assert.equal(verifyEvidencePackageIntegrity(pkg, review), true);

      // Create tampered review (attacker modified quantity from 2 to 20)
      const tamperedReview: ReviewResult = {
        ...review,
        input: {
          ...review.input,
          items: [
            {
              description: "Cloud Architecture Delivery Phase 1",
              quantity: "20", // Tampered
              unitAmount: "1250.00",
            },
          ],
        },
      };

      const tamperedValid = verifyEvidencePackageIntegrity(pkg, tamperedReview);
      assert.equal(tamperedValid, false, "Tampered items must cause hash mismatch and fail verification");
    });

    it("fails verification when contract quote evidence has been tampered with", async () => {
      const reviewId = "rev_tamper_quote";
      const input = createValidInput();
      const review = runPreflight(input);
      const approvalHash = sign(JSON.stringify(review));
      registerMemoryReview(reviewId, { review, approval_hash: approvalHash });

      const event = createSyntheticDisputeEvent(
        { event_type: "CUSTOMER.DISPUTE.CREATED" },
        { custom: reviewId }
      );

      const pkg = await assembleDisputeEvidencePackage(event);
      assert.equal(pkg.status, "ASSEMBLED");

      // Create tampered review (attacker altered quote string)
      const tamperedReview: ReviewResult = {
        ...review,
        input: {
          ...review.input,
          evidence: [
            {
              document: "SOW-8899.pdf",
              page: 2,
              quote: "Attacker modified quote text without authorization",
            },
          ],
        },
      };

      assert.equal(
        verifyEvidencePackageIntegrity(pkg, tamperedReview),
        false,
        "Tampered quote must cause verification failure"
      );
    });

    it("fails verification when HMAC signature has been forged", async () => {
      const reviewId = "rev_tamper_sig";
      const input = createValidInput();
      const review = runPreflight(input);
      const approvalHash = sign(JSON.stringify(review));
      registerMemoryReview(reviewId, { review, approval_hash: approvalHash });

      const event = createSyntheticDisputeEvent(
        { event_type: "CUSTOMER.DISPUTE.CREATED" },
        { custom: reviewId }
      );

      const pkg = await assembleDisputeEvidencePackage(event);
      assert.equal(pkg.status, "ASSEMBLED");

      // Forge the signature
      const forgedPkg = {
        ...pkg,
        hmacSignature: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      };

      assert.equal(
        verifyEvidencePackageIntegrity(forgedPkg, review),
        false,
        "Forged HMAC signature must be rejected"
      );
    });

    it("handles unlinked dispute gracefully with status NO_AUDIT_RECORD_FOUND", async () => {
      const event = createSyntheticDisputeEvent(
        { event_type: "CUSTOMER.DISPUTE.CREATED" },
        {
          custom: "rev_unlinked_unknown_id",
          invoice_number: "PO-UNKNOWN-9999",
          seller_transaction_id: "TXN-UNKNOWN-000",
        }
      );

      const pkg = await assembleDisputeEvidencePackage(event);
      assert.equal(pkg.status, "NO_AUDIT_RECORD_FOUND");
      assert.equal(pkg.verificationHash, "");
      assert.equal(pkg.hmacSignature, "");
      assert.match(pkg.evidenceNotes, /No preflight audit record found/);
    });
  });

  // =========================================================================
  // 5. General Webhook Resilience & Non-Dispute Events
  // =========================================================================
  describe("5. Webhook Delivery Resilience", () => {
    it("returns HTTP 200 for other valid signed PayPal events (e.g. PAYMENT.CAPTURE.COMPLETED)", async () => {
      process.env.PAYPAL_WEBHOOK_ID = "mock-webhook-id";
      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "mock-token", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (urlStr.includes("/v1/notifications/verify-webhook-signature")) {
          return new Response(
            JSON.stringify({ verification_status: "SUCCESS" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      const genericEvent = {
        id: `WH-EVT-GENERIC-${Date.now()}`,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        create_time: new Date().toISOString(),
        resource_type: "capture",
        resource: { id: "CAP-GENERIC-9988", status: "COMPLETED" },
      };

      const req = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          "paypal-transmission-id": `trans-gen-${Date.now()}`,
          "paypal-transmission-sig": "valid-sig",
          "paypal-transmission-time": "2026-11-07T09:00:00Z",
        },
        body: JSON.stringify(genericEvent),
      });

      const res = await webhookRoute(req);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.received, true);
      assert.equal(json.handled, false);
      assert.equal(json.eventType, "PAYMENT.CAPTURE.COMPLETED");
    });
  });
});
