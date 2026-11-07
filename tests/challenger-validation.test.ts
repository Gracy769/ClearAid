import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { runReconciliationAgent } from "../src/lib/agent/reconciliation-agent";
import type { ReviewInput } from "../src/lib/types";

const baseReviewInput: ReviewInput = {
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

describe("Challenger Empirical Validation Harness", () => {
  it("Stress Test 1: Parallel tool calls where create_invoice precedes search_invoicing in step 1", async () => {
    let invoiceCreated = false;
    const model = new MockLanguageModelV1({
      doGenerate: async () => ({
        rawCall: {},
        finishReason: "tool-calls",
        usage: { promptTokens: 50, completionTokens: 40 },
        toolCalls: [
          {
            toolCallType: "function",
            toolCallId: "call_c_early",
            toolName: "create_invoice",
            args: JSON.stringify({ reference: "PO-1042" }),
          },
          {
            toolCallType: "function",
            toolCallId: "call_s_after",
            toolName: "search_invoicing",
            args: JSON.stringify({ reference: "PO-1042" }),
          },
        ],
      }),
    });

    const customTools = {
      search_invoicing: {
        execute: async () => ({ items: [] }),
      },
      create_invoice: {
        execute: async () => {
          invoiceCreated = true;
          return { id: "INV-RACE-BYPASS", status: "DRAFT" };
        },
      },
    };

    const result = await runReconciliationAgent({
      reviewInput: baseReviewInput,
      model,
      customTools,
    });

    assert.equal(invoiceCreated, false, "create_invoice must be blocked if executed before search_invoicing");
    assert.equal(result.status, "DISCREPANCY_FOUND");
    assert.equal(result.draftInvoiceId, undefined);
  });

  it("Stress Test 2: Custom audit tool returning { compliant: false } with non-standard issue format", async () => {
    let callIndex = 0;
    let invoiceCreated = false;
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
                toolCallId: "call_s_1",
                toolName: "search_invoicing",
                args: JSON.stringify({ reference: "PO-1042" }),
              },
            ],
          };
        }
        if (callIndex === 2) {
          return {
            rawCall: {},
            finishReason: "tool-calls",
            usage: { promptTokens: 70, completionTokens: 20 },
            toolCalls: [
              {
                toolCallType: "function",
                toolCallId: "call_a_1",
                toolName: "audit_po_terms",
                args: JSON.stringify({ poNumber: "PO-1042", items: [{ description: "Design", quantity: "1", unitAmount: "100" }] }),
              },
            ],
          };
        }
        if (callIndex === 3) {
          return {
            rawCall: {},
            finishReason: "tool-calls",
            usage: { promptTokens: 90, completionTokens: 20 },
            toolCalls: [
              {
                toolCallType: "function",
                toolCallId: "call_c_1",
                toolName: "create_invoice",
                args: JSON.stringify({ reference: "PO-1042" }),
              },
            ],
          };
        }
        return {
          rawCall: {},
          finishReason: "stop",
          usage: { promptTokens: 110, completionTokens: 10 },
          text: "Done",
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
          status: "HOLD",
          summary: "Custom external enterprise audit failed completely",
        }),
      },
      create_invoice: {
        execute: async () => {
          invoiceCreated = true;
          return { id: "INV-BYPASS-CUSTOM-AUDIT", status: "DRAFT" };
        },
      },
    };

    const result = await runReconciliationAgent({
      reviewInput: baseReviewInput,
      model,
      customTools,
    });

    assert.equal(invoiceCreated, false, "Hard gate must block create_invoice when custom audit reports compliant: false");
    assert.equal(result.status, "DISCREPANCY_FOUND");
    assert.equal(result.draftInvoiceId, undefined);
  });

  it("Stress Test 3: LLM attempts subtle parameter modification (e.g. quantity 4 instead of 3)", async () => {
    let callIndex = 0;
    let invoiceCreated = false;
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
                toolCallId: "call_s_param",
                toolName: "search_invoicing",
                args: JSON.stringify({ reference: "PO-1042" }),
              },
            ],
          };
        }
        if (callIndex === 2) {
          return {
            rawCall: {},
            finishReason: "tool-calls",
            usage: { promptTokens: 70, completionTokens: 20 },
            toolCalls: [
              {
                toolCallType: "function",
                toolCallId: "call_a_param",
                toolName: "audit_po_terms",
                args: JSON.stringify({
                  poNumber: "PO-1042",
                  items: [{ description: "Design services", quantity: "3", unitAmount: "250.50" }],
                }),
              },
            ],
          };
        }
        if (callIndex === 3) {
          // Subtle tamper: quantity changed from 3 to 4
          return {
            rawCall: {},
            finishReason: "tool-calls",
            usage: { promptTokens: 90, completionTokens: 30 },
            toolCalls: [
              {
                toolCallType: "function",
                toolCallId: "call_c_param",
                toolName: "create_invoice",
                args: JSON.stringify({
                  reference: "PO-1042",
                  items: [{ name: "Design services", quantity: "4", unit_amount: { currency_code: "USD", value: "250.50" } }],
                }),
              },
            ],
          };
        }
        return {
          rawCall: {},
          finishReason: "stop",
          usage: { promptTokens: 110, completionTokens: 10 },
          text: "Done",
        };
      },
    });

    const customTools = {
      search_invoicing: {
        execute: async () => ({ items: [] }),
      },
      create_invoice: {
        execute: async () => {
          invoiceCreated = true;
          return { id: "INV-TAMPERED-QTY", status: "DRAFT" };
        },
      },
    };

    const result = await runReconciliationAgent({
      reviewInput: baseReviewInput,
      model,
      customTools,
    });

    assert.equal(invoiceCreated, false, "create_invoice must reject quantity tampering");
    assert.equal(result.status, "DISCREPANCY_FOUND");
    assert.equal(result.draftInvoiceId, undefined);
    assert.ok(result.discrepancies.some((d) => d.category === "UNAUTHORIZED_ITEM"));
  });

  it("Stress Test 4: Fully compliant execution with verified baseline proceeds to APPROVED", async () => {
    let callIndex = 0;
    let invoiceCreated = false;
    let sentDraftPayload: unknown = null;

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
                toolCallId: "call_s_ok",
                toolName: "search_invoicing",
                args: JSON.stringify({ reference: "PO-1042" }),
              },
            ],
          };
        }
        if (callIndex === 2) {
          return {
            rawCall: {},
            finishReason: "tool-calls",
            usage: { promptTokens: 70, completionTokens: 20 },
            toolCalls: [
              {
                toolCallType: "function",
                toolCallId: "call_a_ok",
                toolName: "audit_po_terms",
                args: JSON.stringify({
                  poNumber: "PO-1042",
                  items: [{ description: "Design services", quantity: "3", unitAmount: "250.50" }],
                }),
              },
            ],
          };
        }
        if (callIndex === 3) {
          return {
            rawCall: {},
            finishReason: "tool-calls",
            usage: { promptTokens: 90, completionTokens: 20 },
            toolCalls: [
              {
                toolCallType: "function",
                toolCallId: "call_c_ok",
                toolName: "create_invoice",
                args: JSON.stringify({ reference: "PO-1042" }),
              },
            ],
          };
        }
        return {
          rawCall: {},
          finishReason: "stop",
          usage: { promptTokens: 110, completionTokens: 10 },
          text: "Invoice created successfully.",
        };
      },
    });

    const customTools = {
      search_invoicing: {
        execute: async () => ({ items: [] }),
      },
      create_invoice: {
        execute: async (draft: unknown) => {
          invoiceCreated = true;
          sentDraftPayload = draft;
          return { id: "INV-CLEAN-1042", status: "DRAFT" };
        },
      },
    };

    const result = await runReconciliationAgent({
      reviewInput: baseReviewInput,
      model,
      customTools,
    });

    assert.equal(invoiceCreated, true, "create_invoice should execute when everything is clean");
    assert.equal(result.status, "APPROVED");
    assert.equal(result.draftInvoiceId, "INV-CLEAN-1042");
    assert.ok(sentDraftPayload, "Payload dispatched to create_invoice");
  });
});
