import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { runReconciliationAgent } from "../src/lib/agent/reconciliation-agent";
import type { ReviewInput } from "../src/lib/types";

const baselinePOInput: ReviewInput = {
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

describe("Adversarial Stress Suite: Tool Exception Resilience & Failure Recovery", () => {
  describe("1. search_invoicing Exception & Network Error Trapping", () => {
    it("traps HTTP 500 Internal Server Error without crashing with ToolExecutionError", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_500",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ resource_type: "invoice", invoice_filters: { reference: "PO-1042" } }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 70, completionTokens: 20 },
            text: "Aborting due to PayPal 500 error in duplicate search.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => {
            throw new Error("HTTP 500 Internal Server Error: PayPal backend failure");
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      assert.ok(result, "Agent completed without throwing ToolExecutionError");
      assert.equal(result.draftInvoiceId, undefined);
      assert.equal(result.steps.length, 2);

      const searchStep = result.steps[0];
      assert.equal(searchStep.toolResults.length, 1);
      const toolRes = searchStep.toolResults[0].result as Record<string, unknown>;
      assert.equal(toolRes.isError, true);
      assert.ok(String(toolRes.error).includes("HTTP 500 Internal Server Error"));
    });

    it("traps network timeout (ETIMEDOUT / socket hang up) gracefully", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_timeout",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 70, completionTokens: 20 },
            text: "Network timeout encountered. Deliberation paused safely.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => {
            const err = new Error("connect ETIMEDOUT 192.168.1.1:443");
            (err as unknown as Record<string, unknown>).code = "ETIMEDOUT";
            throw err;
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      assert.equal(result.draftInvoiceId, undefined);
      const searchRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(searchRes.isError, true);
      assert.ok(String(searchRes.error).includes("ETIMEDOUT"));
    });

    it("traps fetch failure (TypeError: fetch failed / connection reset)", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_fetchfail",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 70, completionTokens: 20 },
            text: "Fetch failed, trapped cleanly.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => {
            throw new TypeError("fetch failed: ECONNRESET");
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      assert.equal(result.draftInvoiceId, undefined);
      const toolRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(toolRes.isError, true);
      assert.ok(String(toolRes.error).includes("fetch failed"));
    });

    it("traps non-Error thrown primitive: string rejection", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_str",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 70, completionTokens: 20 },
            text: "Handled string exception safely.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => {
            // Non-standard thrown value
            throw "CRITICAL_PAYPAL_GATEWAY_CRASH";
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      assert.equal(result.draftInvoiceId, undefined);
      const toolRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(toolRes.isError, true);
      assert.equal(toolRes.error, "CRITICAL_PAYPAL_GATEWAY_CRASH");
    });

    it("traps non-Error thrown primitive: null / undefined / plain object", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_obj",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 70, completionTokens: 20 },
            text: "Handled object rejection safely.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => {
            throw { status: 504, error: "Gateway Timeout" };
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      assert.equal(result.draftInvoiceId, undefined);
      const toolRes = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(toolRes.isError, true);
      assert.ok(String(toolRes.error).includes("[object Object]"));
    });
  });

  describe("2. create_invoice Exception & Network Error Trapping", () => {
    it("traps HTTP 429 Rate Limit Exceeded without crashing ReAct loop", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_ok",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          if (stepCount === 2) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 25 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_audit_ok",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-1042",
                    items: [{ description: "Design services", quantity: "3", unitAmount: "250.50" }],
                  }),
                },
              ],
            };
          }
          if (stepCount === 3) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 110, completionTokens: 30 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_429",
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
            usage: { promptTokens: 140, completionTokens: 30 },
            text: "PayPal returned 429 rate limit. Halting gracefully.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({ items: [] }),
        },
        audit_po_terms: {
          execute: async () => ({ compliant: true, issues: [] }),
        },
        create_invoice: {
          execute: async () => {
            throw new Error("HTTP 429 Too Many Requests: Rate limit exceeded on /v2/invoicing/invoices");
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      assert.equal(result.draftInvoiceId, undefined);
      assert.equal(result.steps.length, 4);

      const createStep = result.steps[2];
      const createRes = createStep.toolResults[0].result as Record<string, unknown>;
      assert.equal(createRes.isError, true);
      assert.ok(String(createRes.error).includes("429 Too Many Requests"));
    });

    it("traps PayPal 503 Service Unavailable / Maintenance window", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_503",
                  toolName: "create_invoice",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 80, completionTokens: 20 },
            text: "Service unavailable.",
          };
        },
      });

      const customTools = {
        create_invoice: {
          execute: async () => {
            throw new Error("HTTP 503 Service Unavailable: PayPal Sandbox under scheduled maintenance");
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      assert.equal(result.draftInvoiceId, undefined);
      const res = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(res.isError, true);
      assert.ok(String(res.error).includes("503 Service Unavailable"));
    });

    it("traps non-Error thrown string during create_invoice", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_str",
                  toolName: "create_invoice",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 80, completionTokens: 20 },
            text: "Done.",
          };
        },
      });

      const customTools = {
        create_invoice: {
          execute: async () => {
            throw "PAYPAL_API_FATAL_SOCKET_ERROR";
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      assert.equal(result.draftInvoiceId, undefined);
      const res = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(res.isError, true);
      assert.equal(res.error, "PAYPAL_API_FATAL_SOCKET_ERROR");
    });
  });

  describe("3. audit_po_terms and record_discrepancy Exception Trapping", () => {
    it("traps error thrown inside audit_po_terms without crashing ReAct loop", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_audit_err",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-1042",
                    items: [{ description: "Design", quantity: "1", unitAmount: "100" }],
                  }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 80, completionTokens: 20 },
            text: "Audit tool failed safely.",
          };
        },
      });

      const customTools = {
        audit_po_terms: {
          execute: async () => {
            throw new Error("Internal integer overflow simulation error");
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      assert.equal(result.draftInvoiceId, undefined);
      const res = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(res.isError, true);
      assert.ok(String(res.error).includes("Internal integer overflow"));
    });

    it("traps error thrown inside record_discrepancy without crashing ReAct loop", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_rec_err",
                  toolName: "record_discrepancy",
                  args: JSON.stringify({
                    category: "RATE_MISMATCH",
                    severity: "BLOCKING",
                    description: "Rate mismatch",
                  }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 80, completionTokens: 20 },
            text: "Record discrepancy handled safely.",
          };
        },
      });

      const customTools = {
        record_discrepancy: {
          execute: async () => {
            throw new Error("Audit ledger persistence error");
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      const res = result.steps[0].toolResults[0].result as Record<string, unknown>;
      assert.equal(res.isError, true);
      assert.ok(String(res.error).includes("Audit ledger persistence error"));
    });
  });

  describe("4. Adversarial Deliberation & Gate Bypass Attempts", () => {
    it("prevents draft creation when reviewInput has preflight HOLD status", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_on_hold",
                  toolName: "create_invoice",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 80, completionTokens: 20 },
            text: "Creation rejected due to HOLD.",
          };
        },
      });

      // ReviewInput exceeding PO cap triggers HOLD status in baseline preflight
      const holdInput: ReviewInput = {
        ...baselinePOInput,
        items: [{ description: "Design services", quantity: "100", unitAmount: "250.50" }], // $25,050 vs $1,250 cap
      };

      const customTools = {
        create_invoice: {
          execute: async () => ({ id: "SHOULD_NEVER_BE_CREATED" }),
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: holdInput,
        model,
        customTools,
      });

      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);
      const createStep = result.steps[0];
      const createRes = createStep.toolResults[0].result as Record<string, unknown>;
      assert.equal(createRes.blocked, true);
      assert.ok(String(createRes.error).includes("GATE_REJECTED"));
    });

    it("prevents draft creation when model tries create_invoice after search_invoicing reported an active duplicate", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_dup",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          if (stepCount === 2) {
            // Adversarial attempt to create anyway
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_bypass",
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
            text: "Concluded.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({
            items: [{ id: "INV2-ACTIVE-SENT", status: "SENT", total_amount: { value: "751.50" } }],
          }),
        },
        create_invoice: {
          execute: async () => ({ id: "SHOULD_BE_BLOCKED" }),
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      assert.equal(result.status, "DUPLICATE_DETECTED");
      assert.equal(result.draftInvoiceId, undefined);
      const createStep = result.steps[1];
      const createRes = createStep.toolResults[0].result as Record<string, unknown>;
      assert.equal(createRes.blocked, true);
      assert.ok(String(createRes.error).includes("GATE_REJECTED"));
    });

    it("prevents draft creation when record_discrepancy logged a CRITICAL discrepancy", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_rec_crit",
                  toolName: "record_discrepancy",
                  args: JSON.stringify({
                    category: "ENTITY_MISMATCH",
                    severity: "CRITICAL",
                    description: "Buyer name in invoice does not match PO entity",
                  }),
                },
              ],
            };
          }
          if (stepCount === 2) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_after_crit",
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
            text: "Blocked draft successfully.",
          };
        },
      });

      const customTools = {
        create_invoice: {
          execute: async () => ({ id: "SHOULD_BE_BLOCKED" }),
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      assert.equal(result.status, "DISCREPANCY_FOUND");
      assert.equal(result.draftInvoiceId, undefined);
      const createStep = result.steps[1];
      const createRes = createStep.toolResults[0].result as Record<string, unknown>;
      assert.equal(createRes.blocked, true);
      assert.ok(String(createRes.error).includes("GATE_REJECTED"));
    });

    it("evaluates agent status when create_invoice throws an API error", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_search_ok",
                  toolName: "search_invoicing",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          if (stepCount === 2) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 80, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_audit_ok",
                  toolName: "audit_po_terms",
                  args: JSON.stringify({
                    poNumber: "PO-1042",
                    items: [{ description: "Design services", quantity: "3", unitAmount: "250.50" }],
                  }),
                },
              ],
            };
          }
          if (stepCount === 3) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 110, completionTokens: 20 },
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_create_fail",
                  toolName: "create_invoice",
                  args: JSON.stringify({ reference: "PO-1042" }),
                },
              ],
            };
          }
          return {
            rawCall: {},
            finishReason: "stop",
            usage: { promptTokens: 140, completionTokens: 30 },
            text: "Failed to create invoice draft due to PayPal Sandbox 503 outage.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({ items: [] }),
        },
        audit_po_terms: {
          execute: async () => ({ compliant: true, issues: [] }),
        },
        create_invoice: {
          execute: async () => {
            throw new Error("HTTP 503 Service Unavailable: PayPal Invoicing API is offline");
          },
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      // Verification: draftInvoiceId MUST NOT be created
      assert.equal(result.draftInvoiceId, undefined);
      // Tool result MUST contain caught error
      const createStep = result.steps[2];
      const createRes = createStep.toolResults[0].result as Record<string, unknown>;
      assert.equal(createRes.isError, true);
      assert.ok(String(createRes.error).includes("HTTP 503 Service Unavailable"));
    });

    it("deliberation audit trail contains all raw tool inputs, outputs, and thoughts", async () => {
      let stepCount = 0;
      const model = new MockLanguageModelV1({
        doGenerate: async () => {
          stepCount++;
          if (stepCount === 1) {
            return {
              rawCall: {},
              finishReason: "tool-calls",
              usage: { promptTokens: 50, completionTokens: 20 },
              text: "Step 1: Check for duplicate billing records first.",
              toolCalls: [
                {
                  toolCallType: "function",
                  toolCallId: "call_s1",
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
            text: "Step 2: Conclude deliberation.",
          };
        },
      });

      const customTools = {
        search_invoicing: {
          execute: async () => ({ items: [] }),
        },
      };

      const result = await runReconciliationAgent({
        reviewInput: baselinePOInput,
        model,
        customTools,
      });

      assert.equal(result.steps.length, 2);
      assert.equal(result.steps[0].thought, "Step 1: Check for duplicate billing records first.");
      assert.equal(result.steps[0].toolCalls[0].toolName, "search_invoicing");
      assert.deepEqual(result.steps[0].toolCalls[0].args, { reference: "PO-1042" });
      assert.ok(result.steps[0].toolResults[0].result);
    });
  });
});

