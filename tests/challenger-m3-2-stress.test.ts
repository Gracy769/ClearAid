import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { NextRequest } from "next/server";
import { POST as webhookRoute } from "../src/app/api/paypal/webhooks/invoicing/route";
import {
  getPayPalAccessToken,
  _resetPayPalTokenCache,
} from "../src/lib/paypal";
import {
  assembleDisputeEvidencePackage,
  verifyEvidencePackageIntegrity,
  registerMemoryReview,
  clearMemoryReviews,
  type PayPalDisputeEvent,
  type DisputeEvidencePackage,
} from "../src/lib/dispute";
import { runPreflight } from "../src/lib/preflight";
import { sign } from "../src/lib/security";
import type { ReviewInput, ReviewResult } from "../src/lib/types";

// Ensure environment
process.loadEnvFile?.(".env.local");
process.env.APP_SECRET = process.env.APP_SECRET || "4965d070531229cafc88f882e68af6c6ac0ebe03720a2b09fcdd662adb8479c6";

const originalFetch = globalThis.fetch;

function createBaselineInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    vendorName: "Apex Defense Systems Corp",
    buyerName: "Cyberdyne Global Logistics",
    buyerEmail: "billing@cyberdyne.example.com",
    poNumber: "PO-CHALLENGE-2026",
    currency: "USD",
    poCap: "10000.00",
    items: [
      {
        description: "Zero-Trust Mesh Deployment",
        quantity: "3",
        unitAmount: "2500.00",
      },
      {
        description: "Incident Response Audit",
        quantity: "1",
        unitAmount: "1500.00",
      },
    ],
    evidence: [
      {
        document: "SOW-PO-2026.pdf",
        page: 4,
        quote: "Mesh deployment $2500.00/unit x 3, IR Audit $1500.00 approved",
      },
      {
        document: "COMPLETION-SIGN-OFF.pdf",
        page: 1,
        quote: "Milestone deliverables signed and approved by Cyberdyne CTO",
      },
    ],
    documentHash: "a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e",
    ...overrides,
  };
}

function createDisputeEvent(
  overrides: Partial<PayPalDisputeEvent> = {},
  txnOverrides: Record<string, unknown> = {}
): PayPalDisputeEvent {
  return {
    id: `WH-EVT-CHALLENGER-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: "dispute",
    event_type: "CUSTOMER.DISPUTE.CREATED",
    summary: "Buyer filed dispute: Service unauthorized or not delivered",
    resource: {
      dispute_id: "PP-D-CHALLENGER-9900",
      create_time: new Date().toISOString(),
      disputed_transactions: [
        {
          seller_transaction_id: "TXN-SEL-CHALLENGER-9900",
          buyer_transaction_id: "TXN-BUY-CHALLENGER-9900",
          invoice_number: "PO-CHALLENGE-2026",
          custom: "rev_challenger_baseline",
          gross_amount: { currency_code: "USD", value: "9000.00" },
          buyer: { name: "Cyberdyne Global Logistics" },
          seller: { name: "Apex Defense Systems Corp" },
          ...txnOverrides,
        },
      ],
      dispute_amount: { currency_code: "USD", value: "9000.00" },
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      status: "UNDER_REVIEW",
      dispute_state: "REQUIRED_ACTION",
      buyer_response_due_date: "2026-11-25T12:00:00Z",
    },
    ...overrides,
  };
}

describe("Empirical Challenger M3.2: Dispute Resolution, HMAC & Webhook Stress Suite", () => {
  beforeEach(() => {
    _resetPayPalTokenCache();
    clearMemoryReviews();
    globalThis.fetch = originalFetch;
    process.env.APP_SECRET = "4965d070531229cafc88f882e68af6c6ac0ebe03720a2b09fcdd662adb8479c6";
  });

  afterEach(() => {
    _resetPayPalTokenCache();
    clearMemoryReviews();
    globalThis.fetch = originalFetch;
  });

  // =========================================================================
  // SECTION 1: HMAC Integrity & Tampered Payload Invariant Stress
  // =========================================================================
  describe("1. HMAC Anti-Tamper & Modified Payload Fields", () => {
    it("verifies genuine evidence package integrity passes without error", async () => {
      const reviewId = "rev_challenger_baseline";
      const input = createBaselineInput();
      const review = runPreflight(input);
      const approvalHash = sign(JSON.stringify(review));
      registerMemoryReview(reviewId, { review, approval_hash: approvalHash });

      const event = createDisputeEvent({ event_type: "CUSTOMER.DISPUTE.CREATED" }, { custom: reviewId });
      const pkg = await assembleDisputeEvidencePackage(event);

      assert.equal(pkg.status, "ASSEMBLED");
      assert.equal(pkg.reviewId, reviewId);
      assert.equal(verifyEvidencePackageIntegrity(pkg, review), true);
    });

    it("rejects forged or mutated HMAC signature (bit flips, truncation, random strings)", async () => {
      const reviewId = "rev_hmac_forgery";
      const input = createBaselineInput();
      const review = runPreflight(input);
      registerMemoryReview(reviewId, { review, approval_hash: sign(JSON.stringify(review)) });

      const event = createDisputeEvent({}, { custom: reviewId });
      const pkg = await assembleDisputeEvidencePackage(event);

      // Attack A: Single hex character substitution
      const tamperedHex = pkg.hmacSignature.slice(0, -1) + (pkg.hmacSignature.slice(-1) === "a" ? "b" : "a");
      assert.equal(verifyEvidencePackageIntegrity({ ...pkg, hmacSignature: tamperedHex }, review), false);

      // Attack B: Truncated signature
      assert.equal(verifyEvidencePackageIntegrity({ ...pkg, hmacSignature: pkg.hmacSignature.slice(0, 32) }, review), false);

      // Attack C: Completely forged HMAC signed with different key
      const forgedSigDifferentKey = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
      assert.equal(verifyEvidencePackageIntegrity({ ...pkg, hmacSignature: forgedSigDifferentKey }, review), false);

      // Attack D: Empty signature
      assert.equal(verifyEvidencePackageIntegrity({ ...pkg, hmacSignature: "" }, review), false);
    });

    it("detects modification of line item amounts (quantity tampering)", async () => {
      const reviewId = "rev_tamper_qty";
      const input = createBaselineInput();
      const review = runPreflight(input);
      registerMemoryReview(reviewId, { review, approval_hash: sign(JSON.stringify(review)) });

      const event = createDisputeEvent({}, { custom: reviewId });
      const pkg = await assembleDisputeEvidencePackage(event);

      // Attacker inflates quantity of item 0 from 3 to 30
      const tamperedReview: ReviewResult = {
        ...review,
        input: {
          ...review.input,
          items: [
            { description: "Zero-Trust Mesh Deployment", quantity: "30", unitAmount: "2500.00" },
            review.input.items[1],
          ],
        },
      };

      assert.equal(
        verifyEvidencePackageIntegrity(pkg, tamperedReview),
        false,
        "Quantity tampering must fail integrity check"
      );
    });

    it("detects modification of line item unit amount (price tampering)", async () => {
      const reviewId = "rev_tamper_price";
      const input = createBaselineInput();
      const review = runPreflight(input);
      registerMemoryReview(reviewId, { review, approval_hash: sign(JSON.stringify(review)) });

      const event = createDisputeEvent({}, { custom: reviewId });
      const pkg = await assembleDisputeEvidencePackage(event);

      // Attacker changes rate from 2500.00 to 3500.00
      const tamperedReview: ReviewResult = {
        ...review,
        input: {
          ...review.input,
          items: [
            { description: "Zero-Trust Mesh Deployment", quantity: "3", unitAmount: "3500.00" },
            review.input.items[1],
          ],
        },
      };

      assert.equal(
        verifyEvidencePackageIntegrity(pkg, tamperedReview),
        false,
        "Unit amount price tampering must fail integrity check"
      );
    });

    it("detects contract quote evidence modifications", async () => {
      const reviewId = "rev_tamper_quote_detail";
      const input = createBaselineInput();
      const review = runPreflight(input);
      registerMemoryReview(reviewId, { review, approval_hash: sign(JSON.stringify(review)) });

      const event = createDisputeEvent({}, { custom: reviewId });
      const pkg = await assembleDisputeEvidencePackage(event);

      // Attacker altered quote to fabricate contract approval
      const tamperedReview: ReviewResult = {
        ...review,
        input: {
          ...review.input,
          evidence: [
            {
              document: "SOW-PO-2026.pdf",
              page: 4,
              quote: "Fabricated quote: Unlimited charges authorized by client",
            },
            review.input.evidence[1],
          ],
        },
      };

      assert.equal(
        verifyEvidencePackageIntegrity(pkg, tamperedReview),
        false,
        "Altered contract quote text must fail integrity check"
      );
    });

    it("detects documentHash alteration (source document forgery)", async () => {
      const reviewId = "rev_tamper_dochash";
      const input = createBaselineInput();
      const review = runPreflight(input);
      registerMemoryReview(reviewId, { review, approval_hash: sign(JSON.stringify(review)) });

      const event = createDisputeEvent({}, { custom: reviewId });
      const pkg = await assembleDisputeEvidencePackage(event);

      // Attacker points to forged contract PDF hash
      const tamperedReview: ReviewResult = {
        ...review,
        input: {
          ...review.input,
          documentHash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        },
      };

      assert.equal(
        verifyEvidencePackageIntegrity(pkg, tamperedReview),
        false,
        "Forged document hash must fail verification"
      );
    });

    it("detects party identity alteration (vendorName, buyerName, buyerEmail)", async () => {
      const reviewId = "rev_tamper_parties";
      const input = createBaselineInput();
      const review = runPreflight(input);
      registerMemoryReview(reviewId, { review, approval_hash: sign(JSON.stringify(review)) });

      const event = createDisputeEvent({}, { custom: reviewId });
      const pkg = await assembleDisputeEvidencePackage(event);

      // Attack: Divert buyer email
      const divertedEmailReview: ReviewResult = {
        ...review,
        input: { ...review.input, buyerEmail: "attacker-diverted@evil.example.com" },
      };
      assert.equal(verifyEvidencePackageIntegrity(pkg, divertedEmailReview), false);

      // Attack: Change buyer name
      const modifiedBuyerReview: ReviewResult = {
        ...review,
        input: { ...review.input, buyerName: "Rogue Corporation Ltd" },
      };
      assert.equal(verifyEvidencePackageIntegrity(pkg, modifiedBuyerReview), false);

      // Attack: Change vendor name
      const modifiedVendorReview: ReviewResult = {
        ...review,
        input: { ...review.input, vendorName: "Imposter Systems Inc" },
      };
      assert.equal(verifyEvidencePackageIntegrity(pkg, modifiedVendorReview), false);
    });

    it("detects tampered package payload fields (verificationHash, disputeId, reviewId)", async () => {
      const reviewId = "rev_tamper_pkg_fields";
      const input = createBaselineInput();
      const review = runPreflight(input);
      registerMemoryReview(reviewId, { review, approval_hash: sign(JSON.stringify(review)) });

      const event = createDisputeEvent({}, { custom: reviewId });
      const pkg = await assembleDisputeEvidencePackage(event);

      // Attacker altered verificationHash directly on package
      const alteredHashPkg: DisputeEvidencePackage = {
        ...pkg,
        verificationHash: "0000000000000000000000000000000000000000000000000000000000000000",
      };
      assert.equal(verifyEvidencePackageIntegrity(alteredHashPkg, review), false);

      // Attacker swapped disputeId on package to link to a different dispute
      const alteredDisputeIdPkg: DisputeEvidencePackage = {
        ...pkg,
        disputeId: "PP-D-DIFFERENT-DISPUTE-777",
      };
      assert.equal(verifyEvidencePackageIntegrity(alteredDisputeIdPkg, review), false);

      // Attacker swapped reviewId on package
      const alteredReviewIdPkg: DisputeEvidencePackage = {
        ...pkg,
        reviewId: "rev_different_review_id",
      };
      assert.equal(verifyEvidencePackageIntegrity(alteredReviewIdPkg, review), false);
    });
  });

  // =========================================================================
  // SECTION 2: Webhook Route Signature Gates (HTTP 401 on Forged Signatures)
  // =========================================================================
  describe("2. Webhook Signature Forgery Gates (HTTP 401)", () => {
    it("returns HTTP 401 when PayPal API reports verification_status FAILURE", async () => {
      process.env.PAYPAL_WEBHOOK_ID = "mock-webhook-id";
      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify({ access_token: "mock-valid-token", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("/v1/notifications/verify-webhook-signature")) {
          return new Response(JSON.stringify({ verification_status: "FAILURE" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      };

      const event = createDisputeEvent();
      const req = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          "paypal-transmission-id": "fake-trans-id",
          "paypal-transmission-sig": "completely-forged-signature-string",
          "paypal-transmission-time": new Date().toISOString(),
        },
        body: JSON.stringify(event),
      });

      const res = await webhookRoute(req);
      assert.equal(res.status, 401, "Expected HTTP 401 for failed signature verification");
      const json = await res.json();
      assert.match(json.error, /Invalid webhook signature/i);
    });

    it("returns HTTP 401 when PayPal verification API returns HTTP 400 error", async () => {
      process.env.PAYPAL_WEBHOOK_ID = "mock-webhook-id";
      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify({ access_token: "mock-valid-token", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("/v1/notifications/verify-webhook-signature")) {
          return new Response(
            JSON.stringify({ name: "VALIDATION_ERROR", message: "Invalid certificate URL domain" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      };

      const event = createDisputeEvent();
      const req = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://malicious-domain.com/fake-cert.pem",
          "paypal-transmission-id": "trans-malicious-cert",
          "paypal-transmission-sig": "malicious-sig",
          "paypal-transmission-time": new Date().toISOString(),
        },
        body: JSON.stringify(event),
      });

      const res = await webhookRoute(req);
      assert.equal(res.status, 401, "Expected HTTP 401 when PayPal API rejects certificate or signature");
    });
  });

  // =========================================================================
  // SECTION 3: Missing & Malformed Webhook Headers (HTTP 400)
  // =========================================================================
  describe("3. Missing & Malformed Webhook Headers (HTTP 400)", () => {
    const requiredHeaders = [
      "paypal-auth-algo",
      "paypal-cert-url",
      "paypal-transmission-id",
      "paypal-transmission-sig",
      "paypal-transmission-time",
    ];

    for (const missingHeader of requiredHeaders) {
      it(`returns HTTP 400 when header '${missingHeader}' is omitted`, async () => {
        process.env.PAYPAL_WEBHOOK_ID = "mock-webhook-id";
        process.env.PAYPAL_CLIENT_ID = "mock-client-id";
        process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          "paypal-transmission-id": "trans-test",
          "paypal-transmission-sig": "sig-test",
          "paypal-transmission-time": "2026-11-07T09:00:00Z",
        };

        // Remove the target header
        delete headers[missingHeader];

        const req = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
          method: "POST",
          headers,
          body: JSON.stringify(createDisputeEvent()),
        });

        const res = await webhookRoute(req);
        assert.equal(res.status, 400, `Expected HTTP 400 when missing header ${missingHeader}`);
        const json = await res.json();
        assert.match(json.error, /Missing required PayPal signature headers/i);
      });
    }

    it("returns HTTP 400 when all signature headers are missing", async () => {
      process.env.PAYPAL_WEBHOOK_ID = "mock-webhook-id";
      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      const req = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createDisputeEvent()),
      });

      const res = await webhookRoute(req);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.match(json.error, /Missing required PayPal signature headers/i);
    });

    it("returns HTTP 400 when request body is empty or malformed", async () => {
      process.env.PAYPAL_WEBHOOK_ID = "mock-webhook-id";
      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      const headers = {
        "Content-Type": "application/json",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
        "paypal-transmission-id": "trans-test",
        "paypal-transmission-sig": "sig-test",
        "paypal-transmission-time": "2026-11-07T09:00:00Z",
      };

      // Empty string body
      const reqEmpty = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers,
        body: "",
      });
      const resEmpty = await webhookRoute(reqEmpty);
      assert.equal(resEmpty.status, 400);

      // Corrupted JSON body
      const reqCorrupted = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers,
        body: `{"id": "EVT-1", "event_type": "CUSTOMER.DISPUTE.CREATED", "resource": { missing_brackets: `,
      });
      const resCorrupted = await webhookRoute(reqCorrupted);
      assert.equal(resCorrupted.status, 400);
    });

    it("returns HTTP 503 when webhook environment credentials are unconfigured", async () => {
      delete process.env.PAYPAL_WEBHOOK_ID;

      const req = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createDisputeEvent()),
      });

      const res = await webhookRoute(req);
      assert.equal(res.status, 503, "Expected 503 Service Unavailable when PAYPAL_WEBHOOK_ID is unconfigured");
      const json = await res.json();
      assert.match(json.error, /Webhook verification is not configured/i);
    });
  });

  // =========================================================================
  // SECTION 4: OAuth Token Cache Concurrency & Expiry Refresh
  // =========================================================================
  describe("4. OAuth Token Cache: Concurrency & Expiry Handling", () => {
    it("deduplicates 20 concurrent in-flight token requests into EXACTLY 1 network fetch", async () => {
      let networkFetchCount = 0;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          networkFetchCount++;
          // Simulate network latency of 50ms
          await new Promise((resolve) => setTimeout(resolve, 50));
          return new Response(
            JSON.stringify({
              access_token: "token-burst-protection-xyz",
              token_type: "Bearer",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return originalFetch(input);
      };

      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      // 20 simultaneous concurrent calls
      const burstPromises = Array.from({ length: 20 }, () => getPayPalAccessToken());
      const tokens = await Promise.all(burstPromises);

      assert.equal(tokens.length, 20);
      for (const t of tokens) {
        assert.equal(t, "token-burst-protection-xyz");
      }
      assert.equal(networkFetchCount, 1, "Burst of 20 concurrent requests must trigger exactly 1 network fetch");
    });

    it("refreshes cleanly when token has expired or is forced to refresh", async () => {
      let networkFetchCount = 0;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          networkFetchCount++;
          return new Response(
            JSON.stringify({
              access_token: `token-generation-${networkFetchCount}`,
              token_type: "Bearer",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return originalFetch(input);
      };

      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      // 1. Initial fetch
      const token1 = await getPayPalAccessToken();
      assert.equal(token1, "token-generation-1");
      assert.equal(networkFetchCount, 1);

      // 2. Immediate second call -> cached, no network request
      const token2 = await getPayPalAccessToken();
      assert.equal(token2, "token-generation-1");
      assert.equal(networkFetchCount, 1);

      // 3. Force refresh -> triggers fresh fetch
      const token3 = await getPayPalAccessToken({ forceRefresh: true });
      assert.equal(token3, "token-generation-2");
      assert.equal(networkFetchCount, 2);

      // 4. Third normal call -> cached new token
      const token4 = await getPayPalAccessToken();
      assert.equal(token4, "token-generation-2");
      assert.equal(networkFetchCount, 2);
    });

    it("handles OAuth network failure gracefully without deadlock or perpetual cache corruption", async () => {
      let networkFetchCount = 0;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          networkFetchCount++;
          if (networkFetchCount === 1) {
            // First call fails with 500 error
            return new Response("Internal Server Error", { status: 500 });
          }
          // Second call recovers
          return new Response(
            JSON.stringify({
              access_token: "token-recovered-after-fail",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return originalFetch(input);
      };

      process.env.PAYPAL_CLIENT_ID = "mock-client-id";
      process.env.PAYPAL_CLIENT_SECRET = "mock-client-secret";

      // Call 1 fails
      await assert.rejects(
        async () => {
          await getPayPalAccessToken();
        },
        /PayPal OAuth token request failed \(500\)/
      );

      // Call 2 succeeds and does not remain deadlocked
      const token = await getPayPalAccessToken();
      assert.equal(token, "token-recovered-after-fail");
      assert.equal(networkFetchCount, 2);
    });
  });
});
