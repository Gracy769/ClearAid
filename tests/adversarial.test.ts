import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { NextRequest } from "next/server";
import { MockLanguageModelV1 } from "ai/test";

// Route Handlers
import { POST as invoicesRoute } from "../src/app/api/paypal/invoices/route";
import { POST as ordersRoute } from "../src/app/api/paypal/orders/route";
import { POST as captureRoute } from "../src/app/api/paypal/orders/[id]/capture/route";
import { POST as webhookRoute } from "../src/app/api/paypal/webhooks/invoicing/route";

// Core Platform Libraries
import { runPreflight } from "../src/lib/preflight";
import { toPayPalInvoiceDraft, paypalCreateInvoiceSchema } from "../src/lib/paypal-adapter";
import { runReconciliationAgent } from "../src/lib/agent/reconciliation-agent";
import {
  assembleDisputeEvidencePackage,
  verifyEvidencePackageIntegrity,
  registerMemoryReview,
  clearMemoryReviews,
  type PayPalDisputeEvent,
  type DisputeEvidencePackage,
} from "../src/lib/dispute";
import {
  saveReview,
  savePaypalOrder,
  getPaypalOrder,
  _clearMemoryDb,
} from "../src/lib/db";
import { sign, newId } from "../src/lib/security";
import {
  paypalTools,
  getPayPalAccessToken,
  _resetPayPalTokenCache,
  setPayPalOrderMocks,
  resetPayPalOrderMocks,
} from "../src/lib/paypal";
import type { ReviewInput, ReviewResult } from "../src/lib/types";

// Ensure environment (guarded so tests pass on fresh clone without .env.local)
try {
  process.loadEnvFile?.(".env.local");
} catch {
  // Fallback for fresh clone / CI
}
process.env.APP_SECRET =
  process.env.APP_SECRET || "4965d070531229cafc88f882e68af6c6ac0ebe03720a2b09fcdd662adb8479c6";
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || "mock-admin-token";
process.env.PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "mock-paypal-client-id";
process.env.PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "mock-paypal-client-secret";
process.env.PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || "mock-paypal-webhook-id";

const originalFetch = globalThis.fetch;

// Helper to create valid baseline enterprise inputs
function createEnterpriseInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    vendorName: "CyberShield Enterprise Solutions LLC",
    buyerName: "OmniCorp Global Banking",
    buyerEmail: "procurement@omnicorp.example.com",
    poNumber: "PO-ENTERPRISE-2026-9901",
    currency: "USD",
    poCap: "50000.00",
    items: [
      {
        description: "Zero-Trust Architecture Phase 1",
        quantity: "1",
        unitAmount: "12500.00",
      },
      {
        description: "Threat Intel Stream Integration",
        quantity: "1",
        unitAmount: "15000.00",
      },
      {
        description: "Automated Incident Remediation",
        quantity: "1",
        unitAmount: "10000.00",
      },
    ],
    evidence: [
      {
        document: "ENTERPRISE-MSA-2026.pdf",
        page: 3,
        quote: "Phase 1: $12500, Intel: $15000, Remediation: $10000 approved",
      },
      {
        document: "COMPLIANCE-SIGN-OFF.pdf",
        page: 1,
        quote: "OmniCorp CISO approval and acceptance completed",
      },
    ],
    documentHash: "c1d2e3f4a5b67890123456789abcdef0123456789abcdef0123456789abcdef0",
    ...overrides,
  };
}

function createDisputeEvent(
  overrides: Partial<PayPalDisputeEvent> = {},
  txnOverrides: Record<string, unknown> = {}
): PayPalDisputeEvent {
  return {
    id: `WH-EVT-ADV-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: "dispute",
    event_type: "CUSTOMER.DISPUTE.CREATED",
    summary: "Buyer filed dispute: Service unauthorized or discrepancy reported",
    resource: {
      dispute_id: "PP-D-ADV-9901",
      create_time: new Date().toISOString(),
      disputed_transactions: [
        {
          seller_transaction_id: "TXN-SEL-ADV-9901",
          buyer_transaction_id: "5O190127TN364715C",
          invoice_number: "PO-ENTERPRISE-2026-9901",
          custom: "rev_e2e_golden",
          gross_amount: { currency_code: "USD", value: "37500.00" },
          buyer: { name: "OmniCorp Global Banking" },
          seller: { name: "CyberShield Enterprise Solutions LLC" },
          ...txnOverrides,
        },
      ],
      dispute_amount: { currency_code: "USD", value: "37500.00" },
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      status: "UNDER_REVIEW",
      dispute_state: "REQUIRED_ACTION",
      buyer_response_due_date: "2026-11-30T12:00:00Z",
    },
    ...overrides,
  };
}

describe("Milestone 4: Comprehensive Adversarial Test Suite", () => {
  let origCreateInvoiceExecute: ((...args: unknown[]) => Promise<unknown>) | undefined;

  beforeEach(() => {
    _clearMemoryDb();
    clearMemoryReviews();
    _resetPayPalTokenCache();
    resetPayPalOrderMocks();
    globalThis.fetch = originalFetch;

    process.env.PAYPAL_CLIENT_ID = "mock-paypal-client-id";
    process.env.PAYPAL_CLIENT_SECRET = "mock-paypal-client-secret";
    process.env.PAYPAL_WEBHOOK_ID = "mock-paypal-webhook-id";

    // Stash and setup toolkit create_invoice tool mock
    try {
      const tools = paypalTools();
      if (tools.create_invoice && !origCreateInvoiceExecute) {
        origCreateInvoiceExecute = tools.create_invoice.execute as unknown as (
          ...args: unknown[]
        ) => Promise<unknown>;
      }
    } catch {
      // Credentials fallback
    }
  });

  afterEach(() => {
    _clearMemoryDb();
    clearMemoryReviews();
    _resetPayPalTokenCache();
    resetPayPalOrderMocks();
    globalThis.fetch = originalFetch;

    try {
      const tools = paypalTools();
      if (tools.create_invoice && origCreateInvoiceExecute) {
        tools.create_invoice.execute = origCreateInvoiceExecute as never;
      }
    } catch {
      // Ignore
    }
  });

  // =========================================================================
  // TIER 1: Grand Unified Full Life-Cycle Pipeline
  // =========================================================================
  describe("Tier 1: Grand Unified Full Life-Cycle Pipeline", () => {
    it("1.1 Golden Path: Ingest -> Preflight -> ReAct -> Draft -> Order -> Capture -> Dispute", async () => {
      // 1. Ingest & Preflight Audit
      const input = createEnterpriseInput();
      const review = runPreflight(input);
      assert.equal(review.status, "READY");
      assert.equal(review.totalMinor, 3750000); // $37,500.00 in minor integer cents

      const reviewId = newId("rev_e2e_golden");
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);
      registerMemoryReview(reviewId, { review, approval_hash: approvalHash });

      // 2. Autonomous ReAct Reconciliation Agent
      let callIndex = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              rawCall: { rawPrompt: null, rawSettings: {} },
              finishReason: "tool-calls",
              usage: { promptTokens: 60, completionTokens: 25 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_e2e",
                  toolName: "search_invoicing",
                  args: JSON.stringify({
                    resource_type: "invoice",
                    invoice_filters: { reference: "PO-ENTERPRISE-2026-9901" },
                  }),
                },
              ],
            };
          }
          if (callIndex === 2) {
            return {
              rawCall: { rawPrompt: null, rawSettings: {} },
              finishReason: "tool-calls",
              usage: { promptTokens: 90, completionTokens: 35 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_audit_e2e",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-ENTERPRISE-2026-9901",
                    items: input.items,
                    poCap: input.poCap,
                  }),
                },
              ],
            };
          }
          if (callIndex === 3) {
            return {
              rawCall: { rawPrompt: null, rawSettings: {} },
              finishReason: "tool-calls",
              usage: { promptTokens: 130, completionTokens: 45 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_e2e",
                  toolName: "create_invoice",
                  args: JSON.stringify({
                    currency_code: "USD",
                    reference: "PO-ENTERPRISE-2026-9901",
                    note: "Enterprise contract PO-ENTERPRISE-2026-9901 verified clean",
                    primary_recipients: [
                      {
                        billing_info: {
                          business_name: "OmniCorp Global Banking",
                          email_address: "procurement@omnicorp.example.com",
                        },
                      },
                    ],
                    items: [
                      {
                        name: "Zero-Trust Architecture Phase 1",
                        quantity: "1",
                        unit_amount: { currency_code: "USD", value: "12500.00" },
                      },
                      {
                        name: "Threat Intel Stream Integration",
                        quantity: "1",
                        unit_amount: { currency_code: "USD", value: "15000.00" },
                      },
                      {
                        name: "Automated Incident Remediation",
                        quantity: "1",
                        unit_amount: { currency_code: "USD", value: "10000.00" },
                      },
                    ],
                  }),
                },
              ],
            };
          }
          return {
            rawCall: { rawPrompt: null, rawSettings: {} },
            finishReason: "stop",
            usage: { promptTokens: 160, completionTokens: 40 },
            text: "Reconciliation successful. Verified clean against PO terms and created draft INV2-DRAFT-E2E-9901.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({ items: [] }),
        },
        audit_po_terms: {
          execute: async () => ({
            compliant: true,
            totalFormatted: "USD 37500.00",
            issues: [],
          }),
        },
        create_invoice: {
          execute: async () => ({
            id: "INV2-DRAFT-E2E-9901",
            status: "DRAFT",
            links: [
              {
                rel: "payer-view",
                href: "https://www.sandbox.paypal.com/invoice/p/#INV2-DRAFT-E2E-9901",
              },
            ],
          }),
        },
      };

      const agentResult = await runReconciliationAgent({
        reviewInput: input,
        model,
        customTools,
      });

      assert.equal(agentResult.status, "APPROVED");
      assert.equal(agentResult.draftInvoiceId, "INV2-DRAFT-E2E-9901");
      assert.equal(agentResult.discrepancies.length, 0);
      assert.equal(agentResult.steps.length, 4);

      // 3. PayPal Draft Creation & Schema Adaptation
      const tools = paypalTools();
      tools.create_invoice.execute = (async () => ({
        id: "INV2-DRAFT-E2E-9901",
        status: "DRAFT",
        links: [
          {
            rel: "payer-view",
            href: "https://www.sandbox.paypal.com/invoice/p/#INV2-DRAFT-E2E-9901",
          },
        ],
      })) as never;

      // Verify schema adaptation matches toolkit contract
      const adapterDraft = toPayPalInvoiceDraft(review);
      const parsedDraft = paypalCreateInvoiceSchema.safeParse(adapterDraft);
      assert.equal(parsedDraft.success, true);
      assert.equal(adapterDraft.items.length, 3);
      assert.equal(adapterDraft.currency_code, "USD");

      const approvalPayload = JSON.stringify({ reviewId, reviewHash: approvalHash });
      const approvalToken = sign(approvalPayload);

      const draftReq = new NextRequest("http://localhost:3000/api/paypal/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewId,
          approvalToken,
          review,
        }),
      });

      const draftRes = await invoicesRoute(draftReq);
      assert.equal(draftRes.status, 200);
      const draftJson = await draftRes.json();
      assert.equal(draftJson.id, "INV2-DRAFT-E2E-9901");
      assert.equal(draftJson.status, "DRAFT");
      assert.ok(draftJson.sendToken);

      // 4. Orders v2 Instant Checkout Session Creation
      const orderId = ("5OADV" + Date.now().toString(36) + "E2EGOLDEN").toUpperCase().padEnd(20, "X");
      setPayPalOrderMocks({
        createOrder: async () => ({
          id: orderId,
          status: "CREATED",
          links: [
            {
              rel: "approve",
              href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
            },
          ],
        }),
      });

      const orderReq = new NextRequest("http://localhost:3000/api/paypal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId }),
      });

      const orderRes = await ordersRoute(orderReq);
      assert.equal(orderRes.status, 200);
      const orderJson = await orderRes.json();
      assert.equal(orderJson.orderId, orderId);
      assert.equal(orderJson.status, "CREATED");
      assert.equal(
        orderJson.approvalUrl,
        `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`
      );

      // Verify order saved in DB
      const dbOrder = await getPaypalOrder(orderId);
      assert.ok(dbOrder);
      assert.equal(dbOrder.status, "CREATED");

      // 5. Atomic Capture Settlement
      const captureId = "CAP-E2E-9901-COMPLETED";
      setPayPalOrderMocks({
        captureOrder: async () => ({
          id: orderId,
          captureId,
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
                      amount: { currency_code: "USD", value: "37500.00" },
                      final_capture: true,
                    },
                  ],
                },
              },
            ],
          },
        }),
      });

      const captureReq = new NextRequest(
        `http://localhost:3000/api/paypal/orders/${orderId}/capture`,
        { method: "POST" }
      );
      const captureRes = await captureRoute(captureReq, {
        params: Promise.resolve({ id: orderId }),
      });
      assert.equal(captureRes.status, 200);
      const captureJson = await captureRes.json();
      assert.equal(captureJson.orderId, orderId);
      assert.equal(captureJson.status, "COMPLETED");
      assert.equal(captureJson.captureId, captureId);

      // Verify DB status updated to COMPLETED
      const capturedDbOrder = await getPaypalOrder(orderId);
      assert.equal(capturedDbOrder?.status, "COMPLETED");
      assert.equal(capturedDbOrder?.capture_id, captureId);

      // 6. Dispute Webhook Simulation & Defense Package Verification
      const disputeEvent = createDisputeEvent(
        { id: "WH-EVT-GOLDEN-001", event_type: "CUSTOMER.DISPUTE.CREATED" },
        { custom: reviewId, buyer_transaction_id: orderId }
      );

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "mock-valid-token", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (urlStr.includes("/v1/notifications/verify-webhook-signature")) {
          return new Response(JSON.stringify({ verification_status: "SUCCESS" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return originalFetch(input);
      };

      const webhookReq = new NextRequest(
        "http://localhost:3000/api/paypal/webhooks/invoicing",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "paypal-auth-algo": "SHA256withRSA",
            "paypal-cert-url":
              "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
            "paypal-transmission-id": "trans-e2e-golden",
            "paypal-transmission-sig": "valid-sig-golden",
            "paypal-transmission-time": new Date().toISOString(),
          },
          body: JSON.stringify(disputeEvent),
        }
      );

      const webhookRes = await webhookRoute(webhookReq);
      assert.equal(webhookRes.status, 200);
      const webhookJson = await webhookRes.json();
      assert.equal(webhookJson.received, true);
      assert.equal(webhookJson.duplicate, false);

      const pkg = webhookJson.evidencePackage as DisputeEvidencePackage;
      assert.ok(pkg);
      assert.equal(pkg.status, "ASSEMBLED");
      assert.equal(pkg.reviewId, reviewId);
      assert.equal(pkg.authorizedTotal, "USD 37500.00");
      assert.equal(pkg.poNumber, "PO-ENTERPRISE-2026-9901");
      assert.equal(pkg.vendorName, "CyberShield Enterprise Solutions LLC");
      assert.ok(pkg.evidenceDocuments.length >= 2);

      // Verify HMAC defense audit trail passes integrity check
      const isIntegrityValid = verifyEvidencePackageIntegrity(pkg, review);
      assert.equal(
        isIntegrityValid,
        true,
        "Defense package HMAC and content citations must pass full cryptographic audit verification"
      );
    });

    it("1.2 Adversarial Branch A: PO Rate Discrepancy Halts Pipeline at Reconciliation Gate", async () => {
      // Review input where rate card overrun triggers discrepancy
      const discrepantInput = createEnterpriseInput({
        items: [
          {
            description: "Zero-Trust Architecture Phase 1",
            quantity: "1",
            unitAmount: "19500.00", // Inflated rate (expected 12500.00)
          },
        ],
        poCap: "15000.00", // Cap exceeded ($19,500 > $15,000)
      });

      const review = runPreflight(discrepantInput);
      assert.equal(review.status, "HOLD");
      assert.ok(review.findings.some((f) => f.code === "po_cap_exceeded"));

      const reviewId = newId("rev_e2e_discrepant");
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);

      // ReAct Agent evaluates discrepancies
      let callIndex = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              rawCall: { rawPrompt: null, rawSettings: {} },
              finishReason: "tool-calls",
              usage: { promptTokens: 60, completionTokens: 25 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_audit_disc",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-ENTERPRISE-2026-9901",
                    items: discrepantInput.items,
                    poCap: discrepantInput.poCap,
                  }),
                },
              ],
            };
          }
          if (callIndex === 2) {
            return {
              rawCall: { rawPrompt: null, rawSettings: {} },
              finishReason: "tool-calls",
              usage: { promptTokens: 90, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_disc_record",
                  toolName: "record_discrepancy",
                  args: JSON.stringify({
                    category: "PO_CAP_EXCEEDED",
                    severity: "block",
                    field: "total",
                    expected: "15000.00",
                    actual: "19500.00",
                    description: "Total charges exceed contractual spend cap of $15,000.00",
                  }),
                },
              ],
            };
          }
          return {
            rawCall: { rawPrompt: null, rawSettings: {} },
            finishReason: "stop",
            usage: { promptTokens: 120, completionTokens: 30 },
            text: "Reconciliation halted: PO cap overrun detected. No draft created.",
          };
        },
      });

      const customTools = {
        audit_po_terms: {
          execute: async () => ({
            compliant: false,
            issues: ["PO cap of $15000.00 exceeded by $4500.00"],
          }),
        },
        record_discrepancy: {
          execute: async () => ({ recorded: true }),
        },
      };

      const agentResult = await runReconciliationAgent({
        reviewInput: discrepantInput,
        model,
        customTools,
      });

      assert.equal(agentResult.status, "DISCREPANCY_FOUND");
      assert.equal(agentResult.draftInvoiceId, undefined);
      assert.ok(agentResult.discrepancies.length > 0);

      // Downstream: Invoice Route rejects unapproved HOLD review with HTTP 409
      const approvalPayload = JSON.stringify({ reviewId, reviewHash: approvalHash });
      const approvalToken = sign(approvalPayload);

      const draftReq = new NextRequest("http://localhost:3000/api/paypal/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewId,
          approvalToken,
          review,
        }),
      });

      const draftRes = await invoicesRoute(draftReq);
      assert.equal(draftRes.status, 409);
      const draftJson = await draftRes.json();
      assert.match(draftJson.error, /Review is not ready or has changed/i);

      // Downstream: Orders Route rejects non-READY review with HTTP 409
      const orderReq = new NextRequest("http://localhost:3000/api/paypal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId }),
      });

      const orderRes = await ordersRoute(orderReq);
      assert.equal(orderRes.status, 409);
      const orderJson = await orderRes.json();
      assert.match(orderJson.error, /Review status is HOLD or not ready for settlement/i);
    });

    it("1.3 Adversarial Branch B: Active Duplicate PO Invoice Halts Pipeline at Search Gate", async () => {
      const input = createEnterpriseInput();
      let callIndex = 0;
      let createInvoiceAttempted = false;

      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              rawCall: { rawPrompt: null, rawSettings: {} },
              finishReason: "tool-calls",
              usage: { promptTokens: 60, completionTokens: 25 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_dup",
                  toolName: "search_invoicing",
                  args: JSON.stringify({
                    resource_type: "invoice",
                    invoice_filters: { reference: "PO-ENTERPRISE-2026-9901" },
                  }),
                },
              ],
            };
          }
          if (callIndex === 2) {
            // Adversarial/Hallucinating model attempts create_invoice despite duplicate
            return {
              rawCall: { rawPrompt: null, rawSettings: {} },
              finishReason: "tool-calls",
              usage: { promptTokens: 90, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_hallucinate",
                  toolName: "create_invoice",
                  args: JSON.stringify({
                    currency_code: "USD",
                    reference: "PO-ENTERPRISE-2026-9901",
                  }),
                },
              ],
            };
          }
          return {
            rawCall: { rawPrompt: null, rawSettings: {} },
            finishReason: "stop",
            usage: { promptTokens: 110, completionTokens: 25 },
            text: "Duplicate detected.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({
            items: [
              {
                id: "INV2-PRIOR-PAID-9901",
                status: "PAID",
                detail: { reference: "PO-ENTERPRISE-2026-9901" },
              },
            ],
          }),
        },
        create_invoice: {
          execute: async () => {
            createInvoiceAttempted = true;
            return { id: "INV2-SHOULD-NOT-EXIST" };
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: input,
        model,
        customTools,
      });

      assert.equal(result.status, "DUPLICATE_DETECTED");
      assert.equal(result.draftInvoiceId, undefined);
      assert.equal(
        createInvoiceAttempted,
        false,
        "Programmatic hard gate must strictly block create_invoice execution upon duplicate detection"
      );
    });
  });

  // =========================================================================
  // TIER 2: Realistic Enterprise Procurement Stress Fixtures
  // =========================================================================
  describe("Tier 2: Realistic Enterprise Procurement Stress Fixtures", () => {
    it("2.1 The 'Fractional Penny Rounding Attack' (Sub-Cent SaaS Billing vs Minor Cents)", () => {
      // Sub-cent rates: 33,333 API credits @ $0.0333/credit + 15 seats @ $66.666/seat
      const fractionalInput = createEnterpriseInput({
        poCap: "3000.00",
        items: [
          {
            description: "API Ingestion Tier A Credits",
            quantity: "33333",
            unitAmount: "0.0333", // Non-standard 4-decimal rate
          },
          {
            description: "Enterprise Seat Allocations",
            quantity: "15",
            unitAmount: "66.666", // Non-standard 3-decimal rate
          },
        ],
      });

      // Preflight strictly blocks un-normalized 3+ decimal rates with HOLD
      const rawReview = runPreflight(fractionalInput);
      assert.equal(rawReview.status, "HOLD");
      assert.ok(rawReview.findings.some((f) => f.code.includes("_rate")));

      // Normalizing to valid 2-decimal minor cent format allows preflight and schema adapter to succeed
      const normalizedInput = createEnterpriseInput({
        poCap: "3000.00",
        items: [
          {
            description: "API Ingestion Tier A Credits",
            quantity: "33333",
            unitAmount: "0.03", // Clean 2-decimal representation
          },
          {
            description: "Enterprise Seat Allocations",
            quantity: "15",
            unitAmount: "66.67",
          },
        ],
      });

      const normalizedReview = runPreflight(normalizedInput);
      assert.equal(normalizedReview.status, "READY");
      assert.equal(typeof normalizedReview.totalMinor, "number");
      assert.equal(Number.isInteger(normalizedReview.totalMinor), true);

      // Adapter formats items to compliant 2-decimal strings matching PayPal schema
      const draft = toPayPalInvoiceDraft(normalizedReview);
      const parsed = paypalCreateInvoiceSchema.safeParse(draft);
      assert.equal(parsed.success, true);

      for (const item of draft.items) {
        assert.match(item.unit_amount.value, /^\d+\.\d{2}$/);
      }
    });

    it("2.2 The 'Multi-Currency Arbitrage & Smuggling Attack' (FX Diversion vs USD Constraints)", async () => {
      // Foreign currency EUR or GBP submitted against USD contract
      const eurInput = createEnterpriseInput({
        currency: "EUR",
        sourceTerms: {
          currency: "USD",
          poNumber: "PO-ENTERPRISE-2026-9901",
        },
      });
      const eurReview = runPreflight(eurInput);

      // Preflight holds on source currency mismatch
      assert.equal(eurReview.status, "HOLD");
      assert.ok(eurReview.findings.some((f) => f.code === "source_mismatch_currency"));

      // Orders route blocks HOLD status review with HTTP 409
      const eurReviewId = newId("rev_fx_arbitrage");
      await saveReview(eurReviewId, eurReview, sign(JSON.stringify(eurReview)));

      const holdReq = new NextRequest("http://localhost:3000/api/paypal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId: eurReviewId }),
      });
      const holdRes = await ordersRoute(holdReq);
      assert.equal(holdRes.status, 409);

      // Orders v2 endpoint rejects non-USD currency with HTTP 400 when review is READY
      const readyEurReview: ReviewResult = {
        status: "READY",
        input: createEnterpriseInput({ currency: "EUR" }),
        findings: [],
        totalMinor: 3750000,
      };
      const readyEurId = newId("rev_ready_eur");
      await saveReview(readyEurId, readyEurReview, sign(JSON.stringify(readyEurReview)));

      const curReq = new NextRequest("http://localhost:3000/api/paypal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId: readyEurId }),
      });

      const curRes = await ordersRoute(curReq);
      assert.equal(curRes.status, 400);
      const curJson = await curRes.json();
      assert.match(curJson.error, /USD settlement/i);

      // Adapter validates 3-letter ISO-4217 code and rejects malformed currencies
      assert.throws(() => {
        toPayPalInvoiceDraft({
          ...readyEurReview,
          input: { ...readyEurReview.input, currency: "BITCOIN" },
        });
      }, /Invalid currency code|ISO-4217/i);
    });

    it("2.3 The 'Vendor Legal Entity & Remittance Diversion Attack' (Address & Identity Tampering)", () => {
      // Attacker attempts subtle legal entity divergence against agreed source terms
      const divertedInput = createEnterpriseInput({
        vendorName: "CyberShield Cayman Offshore Holdings LLC",
        buyerEmail: "attacker@phish.example.com",
        sourceTerms: {
          vendorName: "CyberShield Enterprise Solutions LLC",
          buyerEmail: "procurement@omnicorp.example.com",
        },
      });

      const review = runPreflight(divertedInput);
      assert.equal(review.status, "HOLD");
      assert.ok(
        review.findings.some(
          (f) =>
            f.code === "source_mismatch_vendorName" ||
            f.code === "source_mismatch_buyerEmail"
        )
      );
    });

    it("2.4 The 'Phantom Deliverable & Milestone Front-Loading Attack' (PO Cap Exceedance)", () => {
      // Cumulative billing $55,000 exceeds $50,000 cap
      const overcapInput = createEnterpriseInput({
        poCap: "50000.00",
        items: [
          {
            description: "Zero-Trust Architecture Phase 1",
            quantity: "1",
            unitAmount: "25000.00",
          },
          {
            description: "Zero-Trust Architecture Phase 2",
            quantity: "1",
            unitAmount: "30000.00",
          },
        ],
      });

      const review = runPreflight(overcapInput);
      assert.equal(review.status, "HOLD");
      assert.ok(review.findings.some((f) => f.code === "po_cap_exceeded"));
    });
  });

  // =========================================================================
  // TIER 3: High-Contention Concurrency & Race Conditions
  // =========================================================================
  describe("Tier 3: High-Contention Concurrency & Race Condition Verification", () => {
    it("3.1 50-Thread Thundering Herd on OAuth Token Cache (Exact-1 Network Fetch)", async () => {
      let networkFetchCount = 0;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          networkFetchCount++;
          // Simulate 15ms latency
          await new Promise((resolve) => setTimeout(resolve, 15));
          return new Response(
            JSON.stringify({
              access_token: "token-burst-50-protection",
              token_type: "Bearer",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return originalFetch(input);
      };

      _resetPayPalTokenCache();

      // Launch 50 simultaneous callers
      const callers = Array.from({ length: 50 }, () => getPayPalAccessToken());
      const tokens = await Promise.all(callers);

      assert.equal(tokens.length, 50);
      for (const t of tokens) {
        assert.equal(t, "token-burst-50-protection");
      }
      assert.equal(
        networkFetchCount,
        1,
        "50 concurrent token calls must deduplicate into EXACTLY 1 network request"
      );
    });

    it("3.2 25-Thread Concurrent Capture Double-Spend Race (Exact-1 COMPLETED, 24 HTTP 409s)", async () => {
      const orderId = ("5OADV" + Date.now().toString(36) + "RACE25TH").toUpperCase().padEnd(20, "Y");
      const reviewId = newId("rev_race_capture");
      const review = runPreflight(createEnterpriseInput());
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);
      await savePaypalOrder(orderId, reviewId, "CREATED");

      let captureCount = 0;
      setPayPalOrderMocks({
        captureOrder: async () => {
          captureCount++;
          await new Promise((resolve) => setTimeout(resolve, 15));
          return {
            id: orderId,
            status: "COMPLETED",
            purchase_units: [
              {
                reference_id: "default",
                payments: {
                  captures: [
                    {
                      id: `CAP-RACE-${captureCount}`,
                      status: "COMPLETED",
                      amount: { currency_code: "USD", value: "37500.00" },
                      final_capture: true,
                    },
                  ],
                },
              },
            ],
          };
        },
      });

      // Dispatch 25 simultaneous capture requests
      const capturePromises = Array.from({ length: 25 }, () => {
        const req = new NextRequest(
          `http://localhost:3000/api/paypal/orders/${orderId}/capture`,
          { method: "POST" }
        );
        return captureRoute(req, { params: Promise.resolve({ id: orderId }) });
      });

      const responses = await Promise.all(capturePromises);
      const statuses = responses.map((r) => r.status);

      const count200 = statuses.filter((s) => s === 200).length;
      const count409 = statuses.filter((s) => s === 409).length;

      assert.equal(
        count200,
        1,
        `Expected exactly 1 successful HTTP 200 capture, but got ${count200}`
      );
      assert.equal(
        count409,
        24,
        `Expected exactly 24 HTTP 409 conflicts, but got ${count409}`
      );
      assert.equal(
        captureCount,
        1,
        "PayPal payment capture API must only be invoked once"
      );
    });

    it("3.3 20-Thread Concurrent Invoice Draft Reservation Contention (Exact-1 Success, 19 HTTP 409s)", async () => {
      const reviewId = newId("rev_contention_draft");
      const review = runPreflight(createEnterpriseInput());
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);
      const approvalPayload = JSON.stringify({ reviewId, reviewHash: approvalHash });
      const approvalToken = sign(approvalPayload);

      let draftCreationCount = 0;
      const tools = paypalTools();
      tools.create_invoice.execute = (async () => {
        draftCreationCount++;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          id: `INV2-RACE-${draftCreationCount}`,
          status: "DRAFT",
          links: [{ rel: "payer-view", href: "https://sandbox.paypal.com/inv/race" }],
        };
      }) as never;

      // Dispatch 20 simultaneous draft requests for the exact same review
      const draftPromises = Array.from({ length: 20 }, () => {
        const req = new NextRequest("http://localhost:3000/api/paypal/invoices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reviewId,
            approvalToken,
            review,
          }),
        });
        return invoicesRoute(req);
      });

      const responses = await Promise.all(draftPromises);
      const statuses = responses.map((r) => r.status);

      const count200 = statuses.filter((s) => s === 200).length;
      const count409 = statuses.filter((s) => s === 409).length;

      assert.equal(
        count200,
        1,
        `Expected exactly 1 draft creation to succeed (200), got ${count200}`
      );
      assert.equal(
        count409,
        19,
        `Expected exactly 19 draft reservations to conflict (409), got ${count409}`
      );
      assert.equal(draftCreationCount, 1, "create_invoice tool must only execute once");
    });
  });

  // =========================================================================
  // TIER 4: Webhook Invariants, Signature Pre-Validation & Replay Attacks
  // =========================================================================
  describe("Tier 4: Webhook Invariants, Signature Pre-Validation & Replay Attacks", () => {
    it("4.1 Webhook Replay Attack Defense (Idempotency Invariant)", async () => {
      const eventId = "WH-EVT-REPLAY-9901";
      const disputeEvent = createDisputeEvent({
        id: eventId,
        event_type: "CUSTOMER.DISPUTE.CREATED",
      });

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "mock-valid-token", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (urlStr.includes("/v1/notifications/verify-webhook-signature")) {
          return new Response(JSON.stringify({ verification_status: "SUCCESS" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return originalFetch(input);
      };

      const makeRequest = () =>
        new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "paypal-auth-algo": "SHA256withRSA",
            "paypal-cert-url":
              "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
            "paypal-transmission-id": "trans-replay",
            "paypal-transmission-sig": "valid-sig-replay",
            "paypal-transmission-time": new Date().toISOString(),
          },
          body: JSON.stringify(disputeEvent),
        });

      // Delivery 1: Original event delivery
      const res1 = await webhookRoute(makeRequest());
      assert.equal(res1.status, 200);
      const json1 = await res1.json();
      assert.equal(json1.received, true);
      assert.equal(json1.duplicate, false, "Initial delivery must not be flagged as duplicate");

      // Delivery 2: Replay attack with identical eventId
      const res2 = await webhookRoute(makeRequest());
      assert.equal(res2.status, 200);
      const json2 = await res2.json();
      assert.equal(json2.received, true);
      assert.equal(json2.duplicate, true, "Replayed webhook delivery must be detected as duplicate");
    });

    it("4.2 Missing Required Signature Headers Fast-Fail (HTTP 400)", async () => {
      const requiredHeaders = [
        "paypal-auth-algo",
        "paypal-cert-url",
        "paypal-transmission-id",
        "paypal-transmission-sig",
        "paypal-transmission-time",
      ];

      for (const missing of requiredHeaders) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url":
            "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          "paypal-transmission-id": "trans-hdr-test",
          "paypal-transmission-sig": "sig-hdr-test",
          "paypal-transmission-time": new Date().toISOString(),
        };

        delete headers[missing];

        const req = new NextRequest(
          "http://localhost:3000/api/paypal/webhooks/invoicing",
          {
            method: "POST",
            headers,
            body: JSON.stringify(createDisputeEvent()),
          }
        );

        const res = await webhookRoute(req);
        assert.equal(
          res.status,
          400,
          `Expected HTTP 400 when missing header '${missing}', got ${res.status}`
        );
        const json = await res.json();
        assert.match(json.error, /Missing required PayPal signature headers/i);
      }
    });

    it("4.3 Invalid Webhook Signature Rejection (HTTP 401)", async () => {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(
            JSON.stringify({ access_token: "mock-valid-token", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (urlStr.includes("/v1/notifications/verify-webhook-signature")) {
          return new Response(JSON.stringify({ verification_status: "FAILURE" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return originalFetch(input);
      };

      const req = new NextRequest("http://localhost:3000/api/paypal/webhooks/invoicing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url":
            "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
          "paypal-transmission-id": "trans-invalid-sig",
          "paypal-transmission-sig": "forged-transmission-sig",
          "paypal-transmission-time": new Date().toISOString(),
        },
        body: JSON.stringify(createDisputeEvent()),
      });

      const res = await webhookRoute(req);
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.match(json.error, /Invalid webhook signature/i);
    });
  });

  // =========================================================================
  // TIER 5: Cryptographic Anti-Tamper Verification & Defense Audit Trail
  // =========================================================================
  describe("Tier 5: Cryptographic Anti-Tamper Verification & Defense Audit Trail", () => {
    it("5.1 Dispute Evidence Package Anti-Tamper Verification (Field Alterations)", async () => {
      const reviewId = "rev_tamper_defense";
      const input = createEnterpriseInput();
      const review = runPreflight(input);
      const approvalHash = sign(JSON.stringify(review));
      registerMemoryReview(reviewId, { review, approval_hash: approvalHash });

      const disputeEvent = createDisputeEvent({}, { custom: reviewId });
      const pkg = await assembleDisputeEvidencePackage(disputeEvent);

      assert.equal(pkg.status, "ASSEMBLED");
      assert.equal(verifyEvidencePackageIntegrity(pkg, review), true);

      // Attack 1: Alter authorized review total (minor units)
      const tamperedTotalReview: ReviewResult = {
        ...review,
        totalMinor: review.totalMinor + 100000,
      };
      assert.equal(
        verifyEvidencePackageIntegrity(pkg, tamperedTotalReview),
        false,
        "Total minor modification must fail verification"
      );

      // Attack 2: Alter PO Number in review
      const tamperedPoReview: ReviewResult = {
        ...review,
        input: { ...review.input, poNumber: "PO-FORGED-0000" },
      };
      assert.equal(
        verifyEvidencePackageIntegrity(pkg, tamperedPoReview),
        false,
        "PO Number alteration must fail verification"
      );

      // Attack 3: Alter Vendor Name in review
      const tamperedVendorReview: ReviewResult = {
        ...review,
        input: { ...review.input, vendorName: "Imposter LLC" },
      };
      assert.equal(
        verifyEvidencePackageIntegrity(pkg, tamperedVendorReview),
        false,
        "Vendor identity alteration must fail verification"
      );

      // Attack 4: Alter Evidence Document Citation Quote
      const alteredQuoteReview: ReviewResult = {
        ...review,
        input: {
          ...review.input,
          evidence: [
            {
              document: "ENTERPRISE-MSA-2026.pdf",
              page: 3,
              quote: "Fabricated quote: Client authorized unlimited expenses without cap",
            },
            review.input.evidence[1],
          ],
        },
      };
      assert.equal(
        verifyEvidencePackageIntegrity(pkg, alteredQuoteReview),
        false,
        "Evidence citation alteration must fail verification"
      );

      // Attack 5: Tamper with verificationHash on package
      assert.equal(
        verifyEvidencePackageIntegrity(
          { ...pkg, verificationHash: "0000000000000000000000000000000000000000000000000000000000000000" },
          review
        ),
        false,
        "Tampered verificationHash must fail integrity check"
      );

      // Attack 6: Tamper with disputeId on package
      assert.equal(
        verifyEvidencePackageIntegrity(
          { ...pkg, disputeId: "PP-D-SWAPPED-9999" },
          review
        ),
        false,
        "Swapped disputeId must fail integrity check"
      );

      // Attack 7: Tamper with HMAC signature (bit flip)
      const tamperedHmac =
        pkg.hmacSignature.slice(0, -1) + (pkg.hmacSignature.endsWith("a") ? "b" : "a");
      assert.equal(
        verifyEvidencePackageIntegrity({ ...pkg, hmacSignature: tamperedHmac }, review),
        false,
        "Bit-flipped HMAC signature must fail integrity check"
      );
    });

    it("5.2 Cross-Review Approval Token Hijack Rejection (HTTP 403)", async () => {
      // Review A
      const reviewIdA = newId("rev_target_a");
      const reviewA = runPreflight(createEnterpriseInput({ poNumber: "PO-TARGET-A" }));
      const hashA = sign(JSON.stringify(reviewA));
      await saveReview(reviewIdA, reviewA, hashA);
      const tokenA = sign(JSON.stringify({ reviewId: reviewIdA, reviewHash: hashA }));

      // Review B
      const reviewIdB = newId("rev_target_b");
      const reviewB = runPreflight(createEnterpriseInput({ poNumber: "PO-TARGET-B" }));
      const hashB = sign(JSON.stringify(reviewB));
      await saveReview(reviewIdB, reviewB, hashB);

      // Attempt to invoke invoice creation on Review B using Token A
      const req = new NextRequest("http://localhost:3000/api/paypal/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewId: reviewIdB,
          approvalToken: tokenA,
          review: reviewB,
        }),
      });

      const res = await invoicesRoute(req);
      assert.equal(res.status, 403);
      const json = await res.json();
      assert.match(json.error, /Approval is invalid or stale/i);
    });

    it("5.3 Minor-Unit Review Total Tamper Rejection (HTTP 409)", async () => {
      const reviewId = newId("rev_tamper_total");
      const review = runPreflight(createEnterpriseInput());
      const approvalHash = sign(JSON.stringify(review));
      await saveReview(reviewId, review, approvalHash);
      const approvalToken = sign(JSON.stringify({ reviewId, reviewHash: approvalHash }));

      // Inflate totalMinor in review payload
      const tamperedReview: ReviewResult = {
        ...review,
        totalMinor: review.totalMinor + 500000,
      };

      const req = new NextRequest("http://localhost:3000/api/paypal/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewId,
          approvalToken,
          review: tamperedReview,
        }),
      });

      const res = await invoicesRoute(req);
      assert.equal(res.status, 409);
      const json = await res.json();
      assert.match(json.error, /Review is not ready or has changed/i);
    });
  });
});
