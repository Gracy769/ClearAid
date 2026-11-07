import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { runReconciliationAgent } from "../src/lib/agent/reconciliation-agent";
import type { ReviewInput, ReviewResult } from "../src/lib/types";

// Unhandled rejection tracker to verify zero uncaught promise rejections
let unhandledRejectionsCount = 0;
process.on("unhandledRejection", (reason) => {
  unhandledRejectionsCount++;
  console.error("[CHALLENGER_TEST] Unexpected unhandled promise rejection:", reason);
});

const baseCleanInput: ReviewInput = {
  vendorName: "Acme Vendor LLC",
  buyerName: "Global Tech Inc",
  buyerEmail: "billing@globaltech.com",
  poNumber: "PO-7788",
  currency: "USD",
  poCap: "1000.00",
  items: [
    {
      description: "Engineering Consultation",
      quantity: "4",
      unitAmount: "200.00",
    },
  ],
  evidence: [{ document: "SOW.pdf", page: 2, quote: "Engineering consultation rate $200/hr" }],
};

describe("Milestone 2 Challenger 4: Empirical Stress & Edge Case Test Suite", () => {
  // =========================================================================
  // 1. Arithmetic Minor-Unit Conversion, Boundary Rates & PO Caps
  // =========================================================================
  describe("1. Arithmetic Minor-Unit Conversion & Boundary Rates", () => {
    it("handles zero-decimal whole rates (e.g. '200') without arithmetic distortion", async () => {
      let auditToolResult: Record<string, unknown> | null = null;
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          rawCall: {},
          finishReason: "tool-calls",
          usage: { promptTokens: 60, completionTokens: 30 },
          toolCalls: [
            {
              toolCallType: "function",
              toolCallId: "call_audit_whole",
              toolName: "audit_po_terms",
              args: JSON.stringify({
                poNumber: "PO-7788",
                items: [{ description: "Engineering Consultation", quantity: "2", unitAmount: "200" }],
                poCap: "1000.00",
              }),
            },
          ],
        }),
      });

      const result = await runReconciliationAgent({
        reviewInput: {
          ...baseCleanInput,
          items: [{ description: "Engineering Consultation", quantity: "2", unitAmount: "200" }],
        },
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
        },
      });

      auditToolResult = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(auditToolResult.compliant, true);
      assert.equal(auditToolResult.totalMinor, 40000); // 2 * 20000 = 40000 cents ($400.00)
    });

    it("handles 1-decimal rate (e.g. '150.5') normalizing correctly to 15050 minor cents", async () => {
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          rawCall: {},
          finishReason: "tool-calls",
          usage: { promptTokens: 60, completionTokens: 30 },
          toolCalls: [
            {
              toolCallType: "function",
              toolCallId: "call_audit_1dec",
              toolName: "audit_po_terms",
              args: JSON.stringify({
                poNumber: "PO-7788",
                items: [{ description: "Engineering Consultation", quantity: "2", unitAmount: "150.5" }],
                poCap: "1000.00",
              }),
            },
          ],
        }),
      });

      const result = await runReconciliationAgent({
        reviewInput: {
          ...baseCleanInput,
          items: [{ description: "Engineering Consultation", quantity: "2", unitAmount: "150.5" }],
        },
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
        },
      });

      const auditRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(auditRes.compliant, true);
      assert.equal(auditRes.totalMinor, 30100); // 2 * 15050 = 30100 cents
    });

    it("rejects 3-decimal rates ('150.555') as malformed minor units and blocks gate", async () => {
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          rawCall: {},
          finishReason: "tool-calls",
          usage: { promptTokens: 60, completionTokens: 30 },
          toolCalls: [
            {
              toolCallType: "function",
              toolCallId: "call_audit_3dec",
              toolName: "audit_po_terms",
              args: JSON.stringify({
                poNumber: "PO-7788",
                items: [{ description: "Engineering Consultation", quantity: "2", unitAmount: "150.555" }],
                poCap: "1000.00",
              }),
            },
          ],
        }),
      });

      const result = await runReconciliationAgent({
        reviewInput: {
          ...baseCleanInput,
          items: [{ description: "Engineering Consultation", quantity: "2", unitAmount: "150.555" }],
        },
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
        },
      });

      const auditRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(auditRes.compliant, false);
      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);
    });

    it("rejects negative unit rates ('-50.00') in audit_po_terms and prevents draft creation", async () => {
      let callCount = 0;
      let draftCreated = false;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 60, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          if (callCount === 2) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_neg_rate",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-7788",
                    items: [{ description: "Discount item", quantity: "1", unitAmount: "-50.00" }],
                  }),
                },
              ],
            };
          }
          if (callCount === 3) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 100, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create",
                  toolName: "create_invoice",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 120, completionTokens: 10 }, text: "Done." };
        },
      });

      const result = await runReconciliationAgent({
        reviewInput: {
          ...baseCleanInput,
          items: [{ description: "Discount item", quantity: "1", unitAmount: "-50.00" }],
        },
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
          create_invoice: {
            execute: async () => {
              draftCreated = true;
              return { id: "INV-NEGATIVE-RATE" };
            },
          },
        },
      });

      assert.equal(draftCreated, false, "Draft creation must be blocked on negative unit rate");
      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);
    });

    it("rejects negative and zero quantities in audit_po_terms", async () => {
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          rawCall: {},
          finishReason: "tool-calls",
          usage: { promptTokens: 60, completionTokens: 30 },
          toolCalls: [
            {
              toolCallType: "function",
              toolCallId: "call_neg_qty",
              toolName: "audit_po_terms",
              args: JSON.stringify({
                poNumber: "PO-7788",
                items: [
                  { description: "Item A", quantity: "-1", unitAmount: "100.00" },
                  { description: "Item B", quantity: "0", unitAmount: "100.00" },
                ],
              }),
            },
          ],
        }),
      });

      const result = await runReconciliationAgent({
        reviewInput: baseCleanInput,
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
        },
      });

      const auditRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(auditRes.compliant, false);
      const issues = auditRes.findings as Array<Record<string, unknown>>;
      assert.equal(issues.length, 2);
      assert.ok(String(issues[0].message).includes("quantity must be positive whole number"));
      assert.ok(String(issues[1].message).includes("quantity must be positive whole number"));
    });

    it("rejects non-integer fractional quantities ('2.5') in audit_po_terms", async () => {
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          rawCall: {},
          finishReason: "tool-calls",
          usage: { promptTokens: 60, completionTokens: 30 },
          toolCalls: [
            {
              toolCallType: "function",
              toolCallId: "call_fractional_qty",
              toolName: "audit_po_terms",
              args: JSON.stringify({
                poNumber: "PO-7788",
                items: [{ description: "Item A", quantity: "2.5", unitAmount: "100.00" }],
              }),
            },
          ],
        }),
      });

      const result = await runReconciliationAgent({
        reviewInput: baseCleanInput,
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
        },
      });

      const auditRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(auditRes.compliant, false);
      assert.equal(result.status, "DISCREPANCY_FOUND");
    });

    it("evaluates boundary PO cap: exact match passes; 1 cent over fails", async () => {
      // 1. Exact match: total = 500.00, cap = 500.00 -> compliant
      let model = new MockLanguageModelV1({
        doGenerate: async () => ({
          rawCall: {},
          finishReason: "tool-calls",
          usage: { promptTokens: 60, completionTokens: 30 },
          toolCalls: [
            {
              toolCallType: "function",
              toolCallId: "call_cap_exact",
              toolName: "audit_po_terms",
              args: JSON.stringify({
                poNumber: "PO-7788",
                poCap: "500.00",
                items: [{ description: "Item A", quantity: "2", unitAmount: "250.00" }],
              }),
            },
          ],
        }),
      });

      let result = await runReconciliationAgent({
        reviewInput: {
          ...baseCleanInput,
          poCap: "500.00",
          items: [{ description: "Item A", quantity: "2", unitAmount: "250.00" }],
        },
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
        },
      });

      let auditRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(auditRes.compliant, true);

      // 2. 1 cent overage: total = 500.00, cap = 499.99 -> non-compliant, PO_CAP_EXCEEDED
      model = new MockLanguageModelV1({
        doGenerate: async () => ({
          rawCall: {},
          finishReason: "tool-calls",
          usage: { promptTokens: 60, completionTokens: 30 },
          toolCalls: [
            {
              toolCallType: "function",
              toolCallId: "call_cap_over_1cent",
              toolName: "audit_po_terms",
              args: JSON.stringify({
                poNumber: "PO-7788",
                poCap: "499.99",
                items: [{ description: "Item A", quantity: "2", unitAmount: "250.00" }],
              }),
            },
          ],
        }),
      });

      result = await runReconciliationAgent({
        reviewInput: {
          ...baseCleanInput,
          poCap: "499.99",
          items: [{ description: "Item A", quantity: "2", unitAmount: "250.00" }],
        },
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
        },
      });

      auditRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(auditRes.compliant, false);
      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.ok(result.discrepancies.some((d) => d.category === "PO_CAP_EXCEEDED"));
    });

    it("evaluates malformed PO caps (negative, zero, non-numeric)", async () => {
      for (const badCap of ["-100.00", "0", "UNLIMITED", "N/A"]) {
        const model = new MockLanguageModelV1({
          doGenerate: async () => ({
            rawCall: {},
            finishReason: "tool-calls",
            usage: { promptTokens: 60, completionTokens: 30 },
            toolCalls: [
              {
                toolCallType: "function",
                toolCallId: `call_bad_cap_${badCap}`,
                toolName: "audit_po_terms",
                args: JSON.stringify({
                  poNumber: "PO-7788",
                  poCap: badCap,
                  items: [{ description: "Item A", quantity: "1", unitAmount: "50.00" }],
                }),
              },
            ],
          }),
        });

        const result = await runReconciliationAgent({
          reviewInput: {
            ...baseCleanInput,
            poCap: badCap,
            items: [{ description: "Item A", quantity: "1", unitAmount: "50.00" }],
          },
          model,
          customTools: {
            search_invoicing: { execute: async () => ({ items: [] }) },
          },
        });

        const auditRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
        assert.equal(auditRes.compliant, false, `Cap '${badCap}' must fail compliance`);
        assert.equal(result.status, "DISCREPANCY_FOUND");
      }
    });
  });

  // =========================================================================
  // 2. Unusual Currencies & Currency Diversion Defense
  // =========================================================================
  describe("2. Unusual Currencies & Currency Diversion Defense", () => {
    it("approves reconciliation with zero-decimal currency JPY when terms are clean", async () => {
      let draftPayload: Record<string, unknown> | null = null;
      let callCount = 0;

      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 60, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_jpy",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-JPY-01" }),
                },
              ],
            };
          }
          if (callCount === 2) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_audit_jpy",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-JPY-01",
                    currency: "JPY",
                    items: [{ description: "Tokyo Server Hosting", quantity: "1", unitAmount: "50000" }],
                  }),
                },
              ],
            };
          }
          if (callCount === 3) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 100, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_jpy",
                  toolName: "create_invoice",
                  args: JSON.stringify({ reference: "PO-JPY-01" }),
                },
              ],
            };
          }
          return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 120, completionTokens: 10 }, text: "Approved." };
        },
      });

      const result = await runReconciliationAgent({
        reviewInput: {
          ...baseCleanInput,
          poNumber: "PO-JPY-01",
          currency: "JPY",
          poCap: "100000.00",
          items: [{ description: "Tokyo Server Hosting", quantity: "1", unitAmount: "50000" }],
        },
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
          create_invoice: {
            execute: async (draft) => {
              draftPayload = draft as Record<string, unknown>;
              return { id: "INV-JPY-999", status: "DRAFT" };
            },
          },
        },
      });

      assert.equal(result.status, "APPROVED");
      assert.equal(result.draftInvoiceId, "INV-JPY-999");
      assert.equal(draftPayload?.currency_code, "JPY");
    });

    it("approves reconciliation with 3-decimal currencies KWD and BHD", async () => {
      for (const curr of ["KWD", "BHD"]) {
        let callCount = 0;
        const model = new MockLanguageModelV1({
          doGenerate: async () => {
            callCount++;
            if (callCount === 1) {
              return {
                rawCall: {},
                finishReason: "tool-calls",
                usage: { promptTokens: 60, completionTokens: 30 },
                toolCalls: [
                  {
                    toolCallType: "function",
                    toolCallId: `call_search_${curr}`,
                    toolName: "search_invoicing",
                    args: JSON.stringify({ reference: `PO-${curr}-01` }),
                  },
                ],
              };
            }
            if (callCount === 2) {
              return {
                rawCall: {},
                finishReason: "tool-calls",
                usage: { promptTokens: 80, completionTokens: 30 },
                toolCalls: [
                  {
                    toolCallType: "function",
                    toolCallId: `call_create_${curr}`,
                    toolName: "create_invoice",
                    args: JSON.stringify({ reference: `PO-${curr}-01` }),
                  },
                ],
              };
            }
            return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 10 }, text: "Approved." };
          },
        });

        const result = await runReconciliationAgent({
          reviewInput: {
            ...baseCleanInput,
            poNumber: `PO-${curr}-01`,
            currency: curr,
            poCap: "1000.00",
            items: [{ description: "Advisory Service", quantity: "2", unitAmount: "120.00" }],
          },
          model,
          customTools: {
            search_invoicing: { execute: async () => ({ items: [] }) },
            create_invoice: { execute: async () => ({ id: `INV-${curr}-1`, status: "DRAFT" }) },
          },
        });

        assert.equal(result.status, "APPROVED");
        assert.equal(result.draftInvoiceId, `INV-${curr}-1`);
      }
    });

    it("blocks adversarial currency diversion (LLM attempts to alter currency in create_invoice)", async () => {
      let invoiceCreated = false;
      let callCount = 0;

      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 60, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_divert",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          if (callCount === 2) {
            // Adversarial attempt: contract currency is USD, but model attempts EUR
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_divert_curr",
                  toolName: "create_invoice",
                  args: JSON.stringify({
                    reference: "PO-7788",
                    currency_code: "EUR",
                  }),
                },
              ],
            };
          }
          return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 10 }, text: "Done." };
        },
      });

      const result = await runReconciliationAgent({
        reviewInput: baseCleanInput, // base has currency "USD"
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
          create_invoice: {
            execute: async () => {
              invoiceCreated = true;
              return { id: "INV-DIVERTED-CURRENCY" };
            },
          },
        },
      });

      assert.equal(invoiceCreated, false, "create_invoice must reject divergent currency");
      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);

      const createStep = result.steps[1];
      const toolRes = createStep.toolResults[0].result as Record<string, unknown>;
      assert.equal(toolRes.blocked, true);
      assert.ok(String(toolRes.error).includes("Currency mismatch"));
    });
  });

  // =========================================================================
  // 3. Missing Fields & Malformed Inputs
  // =========================================================================
  describe("3. Missing Fields & Malformed Inputs", () => {
    it("halts draft creation when required fields (buyerEmail) are missing", async () => {
      let invoiceCreated = false;
      const model = new MockLanguageModelV1({
        doGenerate: async () => ({
          rawCall: {},
          finishReason: "tool-calls",
          usage: { promptTokens: 60, completionTokens: 30 },
          toolCalls: [
            {
              toolCallType: "function",
              toolCallId: "call_search_m",
              toolName: "search_invoicing",
              args: JSON.stringify({ reference: "PO-7788" }),
            },
            {
              toolCallType: "function",
              toolCallId: "call_create_m",
              toolName: "create_invoice",
              args: JSON.stringify({ reference: "PO-7788" }),
            },
          ],
        }),
      });

      const inputMissingEmail: ReviewInput = {
        ...baseCleanInput,
        buyerEmail: "",
      };

      const result = await runReconciliationAgent({
        reviewInput: inputMissingEmail,
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
          create_invoice: {
            execute: async () => {
              invoiceCreated = true;
              return { id: "INV-MISSING-EMAIL" };
            },
          },
        },
      });

      assert.equal(invoiceCreated, false);
      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);
    });

    it("throws clear error when poData JSON is invalid string", async () => {
      await assert.rejects(
        async () => {
          await runReconciliationAgent({
            poData: "{ invalid-json: true",
          });
        },
        /Invalid poData JSON string provided/
      );
    });

    it("throws clear error when no review, reviewInput, or poData is provided", async () => {
      await assert.rejects(
        async () => {
          await runReconciliationAgent({} as unknown as { reviewInput: ReviewInput });
        },
        /No review, reviewInput, or poData provided/
      );
    });

    it("accepts ReviewResult object under input.review", async () => {
      const reviewResultWrapper: ReviewResult = {
        status: "READY",
        input: baseCleanInput,
        findings: [],
        totalMinor: 80000,
      };

      let callCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 60, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_s_wrapper",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          if (callCount === 2) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_c_wrapper",
                  toolName: "create_invoice",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 10 }, text: "Done." };
        },
      });

      const result = await runReconciliationAgent({
        review: reviewResultWrapper,
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
          create_invoice: { execute: async () => ({ id: "INV-WRAPPER-123", status: "DRAFT" }) },
        },
      });

      assert.equal(result.status, "APPROVED");
      assert.equal(result.draftInvoiceId, "INV-WRAPPER-123");
    });
  });

  // =========================================================================
  // 4. Simulated Tool Exceptions, Timeouts, Aborts & Malformed Payloads
  // =========================================================================
  describe("4. Simulated Tool Exceptions & Failure Trapping", () => {
    it("traps network abort (AbortError) in search_invoicing without uncaught rejection", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_abort",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 70, completionTokens: 10 }, text: "Aborted." };
        },
      });

      const result = await runReconciliationAgent({
        reviewInput: baseCleanInput,
        model,
        customTools: {
          search_invoicing: {
            execute: async () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              throw err;
            },
          },
        },
      });

      assert.equal(result.draftInvoiceId, undefined);
      const toolRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(toolRes.isError, true);
      assert.ok(String(toolRes.error).includes("aborted"));
    });

    it("handles malformed items array in search_invoicing without crashing", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_malformed_items",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 70, completionTokens: 10 }, text: "Done." };
        },
      });

      const result = await runReconciliationAgent({
        reviewInput: baseCleanInput,
        model,
        customTools: {
          search_invoicing: {
            execute: async () => ({
              // Malformed items containing null, undefined, primitive, and object with missing status
              items: [null, undefined, "not-an-item", 42, { id: "INV-1" }, { id: "INV-2", status: "CANCELLED" }],
            }),
          },
        },
      });

      assert.ok(result);
      const searchRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(searchRes.duplicatesFound, false);
    });

    it("traps socket hangup during create_invoice and records tool error cleanly", async () => {
      let callCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_s_hangup",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          if (callCount === 2) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_c_hangup",
                  toolName: "create_invoice",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 10 }, text: "Done." };
        },
      });

      const result = await runReconciliationAgent({
        reviewInput: baseCleanInput,
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
          create_invoice: {
            execute: async () => {
              const err = new Error("socket hang up");
              (err as unknown as Record<string, unknown>).code = "ECONNRESET";
              throw err;
            },
          },
        },
      });

      assert.equal(result.draftInvoiceId, undefined);
      const toolRes = result.steps[1].toolResults[0].result as Record<string, unknown>;
      assert.equal(toolRes.isError, true);
      assert.ok(String(toolRes.error).includes("socket hang up"));
    });

    it("traps customTools audit_po_terms returning non-compliant status and auto-engages blocking gate", async () => {
      let draftCreated = false;
      let callCount = 0;

      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_s_audit_custom",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          if (callCount === 2) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_a_audit_custom",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-7788",
                    items: [{ description: "Consulting", quantity: "1", unitAmount: "200.00" }],
                  }),
                },
              ],
            };
          }
          if (callCount === 3) {
            // Adversarial LLM ignores audit non-compliance
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 110, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_c_audit_custom",
                  toolName: "create_invoice",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 130, completionTokens: 10 }, text: "Done." };
        },
      });

      const result = await runReconciliationAgent({
        reviewInput: baseCleanInput,
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
          audit_po_terms: {
            execute: async () => ({
              compliant: false,
              status: "HOLD",
              summary: "External compliance service flagged terms violation.",
              issues: [
                { field: "rate", severity: "BLOCKING", message: "Exceeds enterprise rate cap." },
              ],
            }),
          },
          create_invoice: {
            execute: async () => {
              draftCreated = true;
              return { id: "INV-SHOULD-NOT-EXIST" };
            },
          },
        },
      });

      assert.equal(draftCreated, false, "Draft creation must be blocked when custom audit reports HOLD");
      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);
      assert.ok(result.discrepancies.some((d) => d.severity === "BLOCKING"));
    });
  });

  // =========================================================================
  // 5. Anti-Tamper Recipient & Line Item Diversion Defense
  // =========================================================================
  describe("5. Anti-Tamper Parameter Diversion Defense", () => {
    it("blocks recipient diversion when LLM attempts to substitute buyer email", async () => {
      let draftCreated = false;
      let callCount = 0;

      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_s_div_email",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          if (callCount === 2) {
            // Adversarial LLM attempts to send invoice to an attacker email
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_c_div_email",
                  toolName: "create_invoice",
                  args: JSON.stringify({
                    reference: "PO-7788",
                    primary_recipients: [
                      {
                        billing_info: {
                          email_address: "attacker@fraudulent-domain.com",
                        },
                      },
                    ],
                  }),
                },
              ],
            };
          }
          return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 10 }, text: "Done." };
        },
      });

      const result = await runReconciliationAgent({
        reviewInput: baseCleanInput, // baseline buyerEmail is billing@globaltech.com
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
          create_invoice: {
            execute: async () => {
              draftCreated = true;
              return { id: "INV-FRAUD-RECIPIENT" };
            },
          },
        },
      });

      assert.equal(draftCreated, false);
      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);

      const createStep = result.steps[1];
      const toolRes = createStep.toolResults[0].result as Record<string, unknown>;
      assert.equal(toolRes.blocked, true);
      assert.ok(String(toolRes.error).includes("Recipient diversion detected"));
    });

    it("blocks line item quantity tampering in create_invoice", async () => {
      let draftCreated = false;
      let callCount = 0;

      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_s_qty_tamper",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-7788" }),
                },
              ],
            };
          }
          if (callCount === 2) {
            // Baseline has quantity 4, adversarial LLM tries quantity 10
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_c_qty_tamper",
                  toolName: "create_invoice",
                  args: JSON.stringify({
                    reference: "PO-7788",
                    items: [
                      {
                        name: "Engineering Consultation",
                        quantity: "10",
                        unit_amount: { currency_code: "USD", value: "200.00" },
                      },
                    ],
                  }),
                },
              ],
            };
          }
          return { rawCall: {}, finishReason: "stop", usage: { promptTokens: 100, completionTokens: 10 }, text: "Done." };
        },
      });

      const result = await runReconciliationAgent({
        reviewInput: baseCleanInput,
        model,
        customTools: {
          search_invoicing: { execute: async () => ({ items: [] }) },
          create_invoice: {
            execute: async () => {
              draftCreated = true;
              return { id: "INV-QUANTITY-TAMPERED" };
            },
          },
        },
      });

      assert.equal(draftCreated, false);
      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);

      const createStep = result.steps[1];
      const toolRes = createStep.toolResults[0].result as Record<string, unknown>;
      assert.equal(toolRes.blocked, true);
      assert.ok(String(toolRes.error).includes("quantity mismatch"));
    });

    it("verifies zero unhandled promise rejections occurred across all test executions", () => {
      assert.equal(
        unhandledRejectionsCount,
        0,
        `Expected zero unhandled promise rejections, but observed ${unhandledRejectionsCount}`
      );
    });
  });
});
