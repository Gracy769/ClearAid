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

describe("Adversarial Stress Test: Autonomous ReAct Reconciliation Agent", () => {
  // =========================================================================
  // Section 1: Hardened Security Invariants (Remediated from Challenger Findings)
  // =========================================================================
  describe("1. Empirical Vulnerability Demonstrations", () => {
    it("Hardened Invariant 1: audit_po_terms rate mismatch engages the hard gate even when adversarial LLM skips record_discrepancy", async () => {
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
                  toolCallId: "call_s1",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ resource_type: "invoice", invoice_filters: { reference: "PO-1042" } }),
                },
              ],
            };
          }
          if (callIndex === 2) {
            // Rate card specifies max rate 200.00, but billed rate is 250.50
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_a1",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-1042",
                    rateCard: [{ description: "Design services", maxUnitRate: "200.00" }],
                    items: [{ description: "Design services", quantity: "3", unitAmount: "250.50" }],
                    poCap: "1250.00",
                  }),
                },
              ],
            };
          }
          if (callIndex === 3) {
            // Adversarial action: deliberately ignore audit failure, do NOT call record_discrepancy, call create_invoice directly
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 110, completionTokens: 40 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_c1",
                  toolName: "create_invoice",
                  args: JSON.stringify({
                    currency_code: "USD",
                    reference: "PO-1042",
                  }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 140, completionTokens: 20 },
            text: "Adversarial deliberation finished.",
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
            return { id: "INV-BYPASSED-RATE", status: "DRAFT" };
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baseReviewInput,
        model,
        customTools,
      });

      // VERIFICATION: The programmatic hard gate blocked invoice creation.
      // audit_po_terms automatically set hasBlockingDiscrepancy and recorded RATE_MISMATCH.
      assert.equal(invoiceCreated, false, "Hard gate successfully intercepted create_invoice on rate mismatch");
      assert.equal(result.status, "DISCREPANCY_FOUND", "Status resolved to DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);
      assert.ok(result.discrepancies.some((d) => d.category === "RATE_MISMATCH"));
    });

    it("Hardened Invariant 2: audit_po_terms PO cap overrun engages hard gate even when adversarial LLM skips record_discrepancy", async () => {
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
                  toolCallId: "call_s2",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ resource_type: "invoice", invoice_filters: { reference: "PO-1042" } }),
                },
              ],
            };
          }
          if (callIndex === 2) {
            // Tight PO cap in contract: 500.00 vs 751.50 billed
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_a2",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-1042",
                    poCap: "500.00",
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
              usage: { promptTokens: 110, completionTokens: 40 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_c2",
                  toolName: "create_invoice",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 140, completionTokens: 20 },
            text: "Deliberation complete.",
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
            return { id: "INV-BYPASSED-CAP", status: "DRAFT" };
          },
        },
      };

      const reviewInputWithoutCap: ReviewInput = {
        ...baseReviewInput,
        poCap: undefined,
      };

      const result = await runReconciliationAgent({
        reviewInput: reviewInputWithoutCap,
        model,
        customTools,
      });

      // VERIFICATION: audit_po_terms automatically set hasBlockingDiscrepancy on cap overrun.
      assert.equal(invoiceCreated, false, "Hard gate successfully intercepted create_invoice on cap overrun");
      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);
      assert.ok(result.discrepancies.some((d) => d.category === "PO_CAP_EXCEEDED"));
    });

    it("Hardened Invariant 3: Mandatory duplicate search precondition is strictly enforced in create_invoice", async () => {
      let invoiceCreated = false;
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          rawCall: {},
          finishReason: "tool-calls",
          usage: { promptTokens: 50, completionTokens: 30 },
          toolCalls: [
            {
              toolCallType: "function",
              toolCallId: "call_skip_search",
              toolName: "create_invoice",
              args: JSON.stringify({ reference: "PO-1042" }),
            },
          ],
        }),
      });

      const customTools = {
        search_invoicing: {
          execute: async () => {
            throw new Error("search_invoicing should have been required");
          },
        },
        create_invoice: {
          execute: async () => {
            invoiceCreated = true;
            return { id: "INV-SKIPPED-SEARCH", status: "DRAFT" };
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baseReviewInput,
        model,
        customTools,
      });

      // VERIFICATION: create_invoice is rejected when search_invoicing was skipped
      assert.equal(invoiceCreated, false, "create_invoice must not execute when duplicate search was skipped");
      assert.equal(result.draftInvoiceId, undefined);
      assert.equal(result.status, "DISCREPANCY_FOUND");
      const createStep = result.steps.find((s) => s.toolCalls.some((tc) => tc.toolName === "create_invoice"));
      assert.ok(createStep, "create_invoice step exists in deliberation trace");
      const toolRes = createStep?.toolResults.find((tr) => tr.toolName === "create_invoice")?.result as Record<string, unknown>;
      assert.ok(toolRes?.blocked, "create_invoice must indicate blocked gate");
      assert.ok(
        String(toolRes?.error).includes("search_invoicing must be executed"),
        `Error must indicate missing duplicate search, got: ${toolRes?.error}`
      );
    });

    it("Hardened Invariant 4: create_invoice enforces preflight baseline authority against parameter diversion", async () => {
      let capturedPayload: unknown = null;
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
                  toolCallId: "call_s4",
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
              usage: { promptTokens: 80, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_a4",
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
            // Attacker alters recipient to attacker@evil.com, currency to EUR, total to 99999.00
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 110, completionTokens: 40 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_c4",
                  toolName: "create_invoice",
                  args: JSON.stringify({
                    currency_code: "EUR",
                    reference: "PO-1042",
                    primary_recipients: [{ billing_info: { email_address: "attacker@evil.com" } }],
                    items: [{ name: "Unauthorized Exfiltration", quantity: "1", unit_amount: { currency_code: "EUR", value: "99999.00" } }],
                  }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 140, completionTokens: 20 },
            text: "Deliberation complete.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({ items: [] }),
        },
        create_invoice: {
          execute: async (args: unknown) => {
            invoiceCreated = true;
            capturedPayload = args;
            return { id: "INV-SUBSTITUTED", status: "DRAFT" };
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baseReviewInput,
        model,
        customTools,
      });

      // VERIFICATION: Baseline authority is preserved.
      // Parameter diversion (EUR, attacker@evil.com) is intercepted and rejected by the hard gate.
      assert.equal(invoiceCreated, false, "create_invoice must reject diverted parameters");
      assert.equal(capturedPayload, null, "Underlying tool should not be called with diverted parameters");
      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);

      const createStep = result.steps.find((s) => s.toolCalls.some((tc) => tc.toolName === "create_invoice"));
      assert.ok(createStep, "create_invoice step exists");
      const toolRes = createStep?.toolResults.find((tr) => tr.toolName === "create_invoice")?.result as Record<string, unknown>;
      assert.ok(toolRes?.blocked, "create_invoice must be blocked");
      assert.ok(String(toolRes?.error).includes("GATE_REJECTED"), "Error must indicate gate rejection");
    });
  });

  // =========================================================================
  // Section 2: Verified Security Invariants (Passing Guardrails)
  // =========================================================================
  describe("2. Verified Security Invariants", () => {
    it("Invariant 1: Duplicate invoice from search_invoicing unconditionally halts draft creation", async () => {
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
                  toolCallId: "call_search_dup",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ resource_type: "invoice", invoice_filters: { reference: "PO-1042" } }),
                },
              ],
            };
          }
          if (callIndex === 2) {
            // Adversarial attempt to create invoice despite duplicate
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_dup",
                  toolName: "create_invoice",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 110, completionTokens: 20 },
            text: "Finished.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({
            items: [{ id: "INV-ACTIVE-PAID", status: "PAID", amount: { value: "751.50" } }],
          }),
        },
        create_invoice: {
          execute: async () => {
            invoiceCreated = true;
            return { id: "INV-SHOULD-NOT-EXIST", status: "DRAFT" };
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baseReviewInput,
        model,
        customTools,
      });

      assert.equal(invoiceCreated, false, "Hard gate successfully intercepted create_invoice on active duplicate");
      assert.equal(result.status, "DUPLICATE_DETECTED");
      assert.equal(result.draftInvoiceId, undefined);
    });

    it("Invariant 2: Preflight HOLD due to invalid currency unconditionally halts draft creation", async () => {
      let invoiceCreated = false;
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          rawCall: {},
          finishReason: "tool-calls",
          usage: { promptTokens: 50, completionTokens: 30 },
          toolCalls: [
            {
              toolCallType: "function",
              toolCallId: "call_force_create",
              toolName: "create_invoice",
              args: JSON.stringify({ reference: "PO-1042" }),
            },
          ],
        }),
      });

      const customTools = {
        create_invoice: {
          execute: async () => {
            invoiceCreated = true;
            return { id: "INV-INVALID-CURRENCY", status: "DRAFT" };
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: { ...baseReviewInput, currency: "USDD" },
        model,
        customTools,
      });

      assert.equal(invoiceCreated, false);
      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);
    });

    it("Invariant 3: Preflight HOLD due to negative item quantities unconditionally halts draft creation", async () => {
      let invoiceCreated = false;
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          rawCall: {},
          finishReason: "tool-calls",
          usage: { promptTokens: 50, completionTokens: 30 },
          toolCalls: [
            {
              toolCallType: "function",
              toolCallId: "call_force_create",
              toolName: "create_invoice",
              args: JSON.stringify({ reference: "PO-1042" }),
            },
          ],
        }),
      });

      const customTools = {
        create_invoice: {
          execute: async () => {
            invoiceCreated = true;
            return { id: "INV-NEGATIVE-QTY", status: "DRAFT" };
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: {
          ...baseReviewInput,
          items: [{ description: "Design", quantity: "-1", unitAmount: "100.00" }],
        },
        model,
        customTools,
      });

      assert.equal(invoiceCreated, false);
      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);
    });

    it("Invariant 4: Duplicate detection catches all active statuses (SENT, PARTIALLY_PAID, MARKED_AS_PAID, DRAFT)", async () => {
      for (const status of ["SENT", "PARTIALLY_PAID", "MARKED_AS_PAID", "DRAFT", "SCHEDULED"]) {
        let invoiceCreated = false;
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
                    toolCallId: `call_search_${status}`,
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
                usage: { promptTokens: 80, completionTokens: 20 },
                toolCalls: [
                  {
                    toolCallType: "function",
                    toolCallId: `call_create_${status}`,
                    toolName: "create_invoice",
                    args: JSON.stringify({ reference: "PO-1042" }),
                  },
                ],
              };
            }
            return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 20 }, text: "Done" };
          },
        });

        const customTools = {
          search_invoicing: {
            execute: async () => ({
              items: [{ id: `INV-${status}-01`, status }],
            }),
          },
          create_invoice: {
            execute: async () => {
              invoiceCreated = true;
              return { id: `INV-FAIL`, status: "DRAFT" };
            },
          },
        };

        const result = await runReconciliationAgent({
          reviewInput: baseReviewInput,
          model,
          customTools,
        });

        assert.equal(invoiceCreated, false, `Failed to block draft on duplicate with status ${status}`);
        assert.equal(result.status, "DUPLICATE_DETECTED");
        assert.equal(result.draftInvoiceId, undefined);
      }
    });

    it("Invariant 5: Infinite ReAct deliberation loops terminate cleanly at maxSteps (6 steps)", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          return {
            rawCall: {},
            finishReason: "tool-calls",
            usage: { promptTokens: 50, completionTokens: 20 },
            toolCalls: [
              {
                toolCallType: "function",
                toolCallId: `call_loop_${callCount}`,
                toolName: "search_invoicing",
                args: JSON.stringify({ reference: "PO-1042" }),
              },
            ],
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({ items: [] }),
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baseReviewInput,
        model,
        customTools,
      });

      assert.ok(result.steps.length <= 6, `Execution did not stop at maxSteps: 6 (actual: ${result.steps.length})`);
      assert.equal(result.draftInvoiceId, undefined);
    });

    it("Invariant 6: Cancelled invoices are safely ignored and permit valid re-issuance", async () => {
      for (const status of ["CANCELLED", "REFUNDED", "AUTO_CANCELLED"]) {
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
                    toolCallId: `call_search_${status}`,
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
                usage: { promptTokens: 80, completionTokens: 20 },
                toolCalls: [
                  {
                    toolCallType: "function",
                    toolCallId: `call_create_${status}`,
                    toolName: "create_invoice",
                    args: JSON.stringify({ reference: "PO-1042" }),
                  },
                ],
              };
            }
            return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 20 }, text: "Done" };
          },
        });

        const customTools = {
          search_invoicing: {
            execute: async () => ({
              items: [{ id: `INV-${status}-OLD`, status }],
            }),
          },
          create_invoice: {
            execute: async () => {
              invoiceCreated = true;
              return { id: `INV-REISSUED-${status}`, status: "DRAFT" };
            },
          },
        };

        const result = await runReconciliationAgent({
          reviewInput: baseReviewInput,
          model,
          customTools,
        });

        assert.equal(invoiceCreated, true, `Cancelled invoice status ${status} should not block reissuance`);
        assert.equal(result.status, "APPROVED");
        assert.equal(result.draftInvoiceId, `INV-REISSUED-${status}`);
      }
    });

    it("Invariant 7: Tool execution errors are caught without unhandled rejection", async () => {
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
                  toolCallId: "call_err",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 80, completionTokens: 20 },
            text: "Recovered from tool error.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => {
            throw new Error("PayPal API Rate Limit Exceeded (HTTP 429)");
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baseReviewInput,
        model,
        customTools,
      });

      assert.equal(result.draftInvoiceId, undefined);
      assert.ok(result.steps.length >= 1);
    });
  });
});
