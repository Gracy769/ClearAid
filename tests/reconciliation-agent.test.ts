import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { runReconciliationAgent } from "../src/lib/agent/reconciliation-agent";
import type { ReviewInput } from "../src/lib/types";

// Standard canonical test fixtures
const validPOInput: ReviewInput = {
  vendorName: "Northstar Studio",
  buyerName: "Acme Corp",
  buyerEmail: "ap@acme.com",
  poNumber: "PO-1042",
  currency: "USD",
  poCap: "1250.00",
  items: [
    {
      description: "Design services",
      quantity: "3",
      unitAmount: "250.50",
    },
  ],
  evidence: [{ document: "PO.pdf", page: 1, quote: "PO-1042 design services" }],
};

describe("Autonomous ReAct Reconciliation Agent Offline Test Suite", () => {
  describe("1. Canonical Deliberation Scenarios", () => {
    it("Scenario A (Happy Path): clean audit -> creates invoice draft -> returns APPROVED", async () => {
      let callIndex = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callIndex++;
          if (callIndex === 1) {
            // Step 1: Agent searches for duplicate invoices
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_1",
                  toolName: "search_invoicing",
                  args: JSON.stringify({
                    resource_type: "invoice",
                    invoice_filters: { reference: "PO-1042" },
                  }),
                },
              ],
            };
          }
          if (callIndex === 2) {
            // Step 2: Zero duplicates found -> Agent audits PO terms
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_audit_1",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-1042",
                    items: [{ description: "Design services", quantity: "3", unitAmount: "250.50" }],
                    poCap: "1250.00",
                  }),
                },
              ],
            };
          }
          if (callIndex === 3) {
            // Step 3: Terms clean -> Agent creates invoice draft
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 120, completionTokens: 40 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_1",
                  toolName: "create_invoice",
                  args: JSON.stringify({
                    currency_code: "USD",
                    reference: "PO-1042",
                    note: "PO PO-1042 verified clean by Autonomous ReAct Agent",
                    primary_recipients: [
                      {
                        billing_info: {
                          business_name: "Acme Corp",
                          email_address: "ap@acme.com",
                        },
                      },
                    ],
                    items: [
                      {
                        name: "Design services",
                        quantity: "3",
                        unit_amount: { currency_code: "USD", value: "250.50" },
                      },
                    ],
                  }),
                },
              ],
            };
          }
          // Step 4: Final explanation
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 150, completionTokens: 50 },
            text: "Reconciliation successful. Zero duplicate invoices found on PayPal, and all PO terms match. Created draft invoice INV2-HAPPY-1042.",
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
            totalFormatted: "USD 751.50",
            issues: [],
          }),
        },
        create_invoice: {
          execute: async () => ({
            id: "INV2-HAPPY-1042",
            status: "DRAFT",
            links: [{ rel: "payer-view", href: "https://www.sandbox.paypal.com/invoice/p/#INV2-HAPPY-1042" }],
          }),
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: validPOInput,
        model,
        customTools,
      });

      assert.equal(result.status, "APPROVED");
      assert.equal(result.draftInvoiceId, "INV2-HAPPY-1042");
      assert.equal(result.discrepancies.length, 0);
      assert.equal(result.steps.length, 4);
      assert.ok(result.summary.includes("INV2-HAPPY-1042"));
      assert.ok(result.steps[0].toolCalls.some((tc) => tc.toolName === "search_invoicing"));
      assert.ok(result.steps[1].toolCalls.some((tc) => tc.toolName === "audit_po_terms"));
      assert.ok(result.steps[2].toolCalls.some((tc) => tc.toolName === "create_invoice"));
    });

    it("Scenario B (Duplicate Billing): detects existing PAID invoice -> halts draft -> returns DUPLICATE_DETECTED", async () => {
      let callIndex = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callIndex++;
          if (callIndex === 1) {
            // Step 1: Search for existing invoices
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_dup",
                  toolName: "search_invoicing",
                  args: JSON.stringify({
                    resource_type: "invoice",
                    invoice_filters: { reference: "PO-1042" },
                  }),
                },
              ],
            };
          }
          if (callIndex === 2) {
            // Step 2: Active duplicate detected -> Agent records discrepancy and halts draft
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 90, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_rec_dup",
                  toolName: "record_discrepancy",
                  args: JSON.stringify({
                    field: "poNumber",
                    expected: "Unbilled PO",
                    actual: "Existing invoice INV2-PAID-9999 already PAID",
                    severity: "BLOCKING",
                    reason: "Duplicate billing detected for PO-1042. Invoice INV2-PAID-9999 is already marked PAID.",
                  }),
                },
              ],
            };
          }
          // Step 3: Deliberation halts with final explanation
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 120, completionTokens: 40 },
            text: "HALT: Duplicate billing detected. Invoice INV2-PAID-9999 has already been paid for PO-1042. Refusing to create new draft.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({
            items: [
              {
                id: "INV2-PAID-9999",
                status: "PAID",
                amount: { value: "751.50", currency_code: "USD" },
              },
            ],
          }),
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: validPOInput,
        model,
        customTools,
      });

      assert.equal(result.status, "DUPLICATE_DETECTED");
      assert.equal(result.draftInvoiceId, undefined);
      assert.equal(result.discrepancies.length, 1);
      assert.equal(result.discrepancies[0].field, "poNumber");
      assert.equal(result.discrepancies[0].severity, "BLOCKING");
      assert.ok(result.summary.includes("Duplicate billing detected"));
    });

    it("Scenario C (PO Discrepancy): unit rate exceeds PO rate -> records discrepancy -> halts draft -> returns DISCREPANCY_FOUND", async () => {
      let callIndex = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_rate",
                  toolName: "search_invoicing",
                  args: JSON.stringify({
                    resource_type: "invoice",
                    invoice_filters: { reference: "PO-1042" },
                  }),
                },
              ],
            };
          }
          if (callIndex === 2) {
            // Step 2: Zero duplicates, proceed to audit PO terms
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_audit_rate",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-1042",
                    items: [{ description: "Design services", quantity: "3", unitAmount: "350.00" }],
                    poCap: "1250.00",
                  }),
                },
              ],
            };
          }
          if (callIndex === 3) {
            // Step 3: Rate mismatch identified -> Agent records discrepancy
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 110, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_rec_disc",
                  toolName: "record_discrepancy",
                  args: JSON.stringify({
                    field: "items[0].unitAmount",
                    expected: "250.50",
                    actual: "350.00",
                    severity: "BLOCKING",
                    reason: "Line item unit rate 350.00 exceeds agreed PO rate 250.50 by 99.50.",
                  }),
                },
              ],
            };
          }
          // Step 4: Final explanation
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 140, completionTokens: 40 },
            text: "HALT: Line item rate mismatch detected. Claimed rate $350.00 exceeds agreed PO rate $250.50. Draft creation blocked.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({ items: [] }),
        },
        audit_po_terms: {
          execute: async () => ({
            compliant: false,
            issues: [
              {
                field: "items[0].unitAmount",
                expected: "250.50",
                actual: "350.00",
                reason: "Unit rate exceeds agreed PO rate card",
              },
            ],
          }),
        },
      };

      const inflatedReview: ReviewInput = {
        ...validPOInput,
        items: [{ description: "Design services", quantity: "3", unitAmount: "350.00" }],
      };

      const result = await runReconciliationAgent({
        reviewInput: inflatedReview,
        model,
        customTools,
      });

      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);
      assert.equal(result.discrepancies.length, 1);
      assert.equal(result.discrepancies[0].field, "items[0].unitAmount");
      assert.equal(result.discrepancies[0].expected, "250.50");
      assert.equal(result.discrepancies[0].actual, "350.00");
      assert.equal(result.discrepancies[0].severity, "BLOCKING");
      assert.ok(result.summary.includes("rate mismatch"));
    });
  });

  describe("2. Edge & Adversarial Safeguards", () => {
    it("Scenario D (Cancelled Invoice): ignores CANCELLED invoices and proceeds to approval", async () => {
      let callIndex = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_cancel",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ resource_type: "invoice", invoice_filters: { reference: "PO-1042" } }),
                },
              ],
            };
          }
          if (callIndex === 2) {
            // Agent notices invoice is CANCELLED -> proceeds to audit
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_audit_cancel",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-1042",
                    items: [{ description: "Design services", quantity: "3", unitAmount: "250.50" }],
                    poCap: "1250.00",
                  }),
                },
              ],
            };
          }
          if (callIndex === 3) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 110, completionTokens: 40 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_cancel",
                  toolName: "create_invoice",
                  args: JSON.stringify({
                    currency_code: "USD",
                    reference: "PO-1042",
                    primary_recipients: [{ billing_info: { email_address: "ap@acme.com" } }],
                    items: [{ name: "Design services", quantity: "3", unit_amount: { currency_code: "USD", value: "250.50" } }],
                  }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 140, completionTokens: 30 },
            text: "Previous invoice was CANCELLED. Created new active draft INV2-REISSUE-1042.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({
            items: [{ id: "INV2-OLD-VOIDED", status: "CANCELLED", amount: { value: "751.50", currency_code: "USD" } }],
          }),
        },
        audit_po_terms: {
          execute: async () => ({ compliant: true, issues: [] }),
        },
        create_invoice: {
          execute: async () => ({ id: "INV2-REISSUE-1042", status: "DRAFT" }),
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: validPOInput,
        model,
        customTools,
      });

      assert.equal(result.status, "APPROVED");
      assert.equal(result.draftInvoiceId, "INV2-REISSUE-1042");
      assert.equal(result.discrepancies.length, 0);
    });

    it("Scenario E (PO Cap Overrun): flags PO cap exceedance and blocks draft creation", async () => {
      let callIndex = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_cap",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ resource_type: "invoice", invoice_filters: { reference: "PO-1042" } }),
                },
              ],
            };
          }
          if (callIndex === 2) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_audit_cap",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-1042",
                    items: [{ description: "Design services", quantity: "10", unitAmount: "250.50" }],
                    poCap: "1250.00",
                  }),
                },
              ],
            };
          }
          if (callIndex === 3) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 110, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_rec_cap",
                  toolName: "record_discrepancy",
                  args: JSON.stringify({
                    field: "totalAmount",
                    expected: "<= 1250.00",
                    actual: "2505.00",
                    severity: "BLOCKING",
                    reason: "Invoice total 2,505.00 exceeds authorized PO cap of 1,250.00 by 1,255.00.",
                  }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 140, completionTokens: 30 },
            text: "HALT: PO cap overrun. Draft invoice creation blocked.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({ items: [] }),
        },
        audit_po_terms: {
          execute: async () => ({
            compliant: false,
            issues: [{ field: "totalAmount", expected: "<= 1250.00", actual: "2505.00", reason: "Cap exceeded" }],
          }),
        },
      };

      const bigReview: ReviewInput = {
        ...validPOInput,
        items: [{ description: "Design services", quantity: "10", unitAmount: "250.50" }],
      };

      const result = await runReconciliationAgent({
        reviewInput: bigReview,
        model,
        customTools,
      });

      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);
      assert.equal(result.discrepancies.length, 1);
      assert.equal(result.discrepancies[0].field, "totalAmount");
    });

    it("Scenario F (Programmatic Hard Gate): rejects draft creation even if hallucinating model calls create_invoice after duplicate", async () => {
      let callIndex = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_hallucinate",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ resource_type: "invoice", invoice_filters: { reference: "PO-1042" } }),
                },
              ],
            };
          }
          if (callIndex === 2) {
            // Adversarial/hallucinated model: tries to create invoice ANYWAY despite duplicate
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_hallucinate",
                  toolName: "create_invoice",
                  args: JSON.stringify({
                    currency_code: "USD",
                    reference: "PO-1042",
                    primary_recipients: [{ billing_info: { email_address: "ap@acme.com" } }],
                    items: [{ name: "Design services", quantity: "3", unit_amount: { currency_code: "USD", value: "250.50" } }],
                  }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 110, completionTokens: 30 },
            text: "Deliberation concluded.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({
            items: [{ id: "INV2-PAID-ALREADY", status: "PAID" }],
          }),
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: validPOInput,
        model,
        customTools,
      });

      // The programmatic hard gate MUST prevent draft creation
      assert.equal(result.status, "DUPLICATE_DETECTED");
      assert.equal(result.draftInvoiceId, undefined);
      // Verify step trace recorded the programmatic gate rejection
      const createStep = result.steps.find((s) => s.toolCalls.some((tc) => tc.toolName === "create_invoice"));
      assert.ok(createStep, "create_invoice was attempted");
      const createResult = createStep?.toolResults.find((tr) => tr.toolName === "create_invoice");
      const resObj = createResult?.result as Record<string, unknown> | undefined;
      assert.ok(
        resObj?.isError || resObj?.error,
        "Tool result must indicate rejection error"
      );
    });

    it("Scenario G (Tool Exception Recovery): traps unexpected API error without crashing ReAct loop", async () => {
      let callIndex = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_fail",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ resource_type: "invoice", invoice_filters: { reference: "PO-1042" } }),
                },
              ],
            };
          }
          // Step 2: Agent observes error from search_invoicing and aborts safely
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 80, completionTokens: 30 },
            text: "HALT: External PayPal API error occurred during duplicate search. Aborting deliberation.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => {
            throw new Error("HTTP 503 Service Unavailable: PayPal Sandbox timeout");
          },
        },
      };

      // Must NOT throw ToolExecutionError; must catch and return status
      const result = await runReconciliationAgent({
        reviewInput: validPOInput,
        model,
        customTools,
      });

      assert.ok(result.summary.includes("PayPal API error"));
      assert.equal(result.draftInvoiceId, undefined);
    });
  });
});
