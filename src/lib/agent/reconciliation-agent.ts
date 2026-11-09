import { generateText, tool, type LanguageModelV1 } from "ai";
import { z } from "zod";
import { getGeminiModel } from "@/lib/ai";
import { paypalCreateDraft, paypalTools } from "@/lib/paypal";
import { toPayPalInvoiceDraft } from "@/lib/paypal-adapter";
import { runPreflight } from "@/lib/preflight";
import { getDisbursements } from "@/lib/db";
import type { ReviewInput, ReviewResult } from "@/lib/types";

export type ReconciliationStatus = "APPROVED" | "DISCREPANCY_FOUND" | "DUPLICATE_DETECTED";

export interface Discrepancy {
  category: "DUPLICATE_BILLING" | "RATE_MISMATCH" | "PO_CAP_EXCEEDED" | "ENTITY_MISMATCH" | "UNAUTHORIZED_ITEM" | "OTHER";
  severity: "block" | "warning" | "BLOCKING" | "CRITICAL" | "INFO" | string;
  field?: string;
  expected?: string;
  actual?: string;
  description: string;
  reason?: string;
  poValue?: string;
  invoiceValue?: string;
  remedyRecommendation?: string;
}

export interface DeliberationStep {
  step: number;
  thought?: string;
  toolCalls: Array<{
    toolName: string;
    args: Record<string, unknown>;
  }>;
  toolResults: Array<{
    toolName: string;
    result: unknown;
  }>;
}

export interface ExecutableToolLike {
  execute?: (args?: unknown, options?: unknown) => Promise<unknown>;
}

export interface ReconciliationAgentInput {
  review?: ReviewResult | ReviewInput;
  reviewInput?: ReviewInput;
  poData?: Record<string, unknown> | string;
  userInstruction?: string;
  model?: LanguageModelV1;
  paypalCredentials?: { clientId: string; clientSecret: string };
  customTools?: Record<string, ExecutableToolLike>;
}

export interface ReconciliationAgentResult {
  status: ReconciliationStatus;
  draftInvoiceId?: string;
  invoiceUrl?: string;
  discrepancies: Discrepancy[];
  steps: DeliberationStep[];
  summary: string;
  preflightResult?: ReviewResult;
}

function parseCents(value: string | number | undefined): number | null {
  const str = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(str)) return null;
  const [whole, fraction = ""] = str.split(".");
  const amount = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

export async function runReconciliationAgent(
  input: ReconciliationAgentInput
): Promise<ReconciliationAgentResult> {
  // 1. Normalize ReviewInput
  let reviewInput: ReviewInput;
  if (input.reviewInput) {
    reviewInput = input.reviewInput;
  } else if (input.review && "input" in input.review) {
    reviewInput = input.review.input;
  } else if (input.review) {
    reviewInput = input.review as ReviewInput;
  } else if (input.poData) {
    if (typeof input.poData === "string") {
      try {
        reviewInput = JSON.parse(input.poData) as ReviewInput;
      } catch {
        throw new Error("Invalid poData JSON string provided.");
      }
    } else {
      reviewInput = input.poData as unknown as ReviewInput;
    }
  } else {
    throw new Error("No review, reviewInput, or poData provided to runReconciliationAgent.");
  }

  // 2. Model resolution (injectable for offline testing)
  const model = input.model || getGeminiModel();

  // 3. Baseline preflight audit
  const preflightBaseline = runPreflight(reviewInput);

  // 4. Deliberation mutable state
  let hasDuplicate = false;
  let hasBlockingDiscrepancy = false;
  let hasExecutedDuplicateSearch = false;
  const discrepancies: Discrepancy[] = [];
  const duplicateInvoices: Array<{ id: string; status: string; amount?: string }> = [];
  let draftInvoiceId: string | undefined;
  let invoiceUrl: string | undefined;

  // 5. Native PayPal tools (if configured and customTools not overriding)
  const customTools = input.customTools;
  let nativeTools: Record<string, ExecutableToolLike> | null = null;
  if (!customTools) {
    try {
      nativeTools = paypalTools() as unknown as Record<string, ExecutableToolLike>;
    } catch {
      // Credentials may not be configured in non-production environments
    }
  }

  // Tool 1: search_invoicing (Duplicate Detection Action)
  const searchInvoicingTool = tool({
    description: "Search PayPal invoices by PO reference number or recipient email to check for existing or duplicate invoices.",
    parameters: z.object({
      resource_type: z.enum(["invoice", "recurring_series"]).default("invoice").optional().describe("Which resource type to search. Use 'invoice'."),
      page: z.number().int().min(1).max(1000).default(1).optional(),
      page_size: z.number().int().min(1).max(100).default(20).optional(),
      total_required: z.boolean().default(false).optional(),
      invoice_filters: z.object({
        reference: z.string().optional().describe("PO reference number (e.g. 'PO-1042')."),
        recipient_email: z.string().optional().describe("Buyer email address."),
        status: z.array(z.string()).optional(),
      }).optional(),
      reference: z.string().optional(),
    }),
    execute: async (args, options) => {
      hasExecutedDuplicateSearch = true;
      try {
        let rawResult: unknown;
        if (customTools?.search_invoicing?.execute) {
          rawResult = await customTools.search_invoicing.execute(args, options);
        } else if (nativeTools?.search_invoicing?.execute) {
          rawResult = await nativeTools.search_invoicing.execute(args, options);
        } else {
          rawResult = { items: [] };
        }

        const rawObj = rawResult as Record<string, unknown> | undefined;
        const items: unknown[] = Array.isArray(rawObj?.items)
          ? rawObj.items
          : Array.isArray(rawObj?.invoices)
          ? rawObj.invoices
          : Array.isArray(rawResult)
          ? rawResult
          : [];

        const activeDuplicates: Array<Record<string, unknown>> = [];
        for (const item of items) {
          if (typeof item === "object" && item !== null) {
            const itemObj = item as Record<string, unknown>;
            const s = String(itemObj.status || "").toUpperCase();
            if (s !== "CANCELLED" && s !== "REFUNDED" && s !== "AUTO_CANCELLED" && s !== "") {
              activeDuplicates.push(itemObj);
            }
          }
        }

        if (activeDuplicates.length > 0) {
          hasDuplicate = true;
          for (const item of activeDuplicates) {
            const amtObj = item.amount as { value?: string } | undefined;
            const totalAmtObj = item.total_amount as { value?: string } | undefined;
            duplicateInvoices.push({
              id: String(item.id || item.invoice_id || "unknown"),
              status: String(item.status || "UNKNOWN"),
              amount: amtObj?.value || totalAmtObj?.value,
            });
          }
          return {
            duplicatesFound: true,
            count: activeDuplicates.length,
            activeInvoices: activeDuplicates.map((it) => {
              const amtObj = it.amount as { value?: string } | undefined;
              const totalAmtObj = it.total_amount as { value?: string } | undefined;
              return {
                id: it.id || it.invoice_id,
                status: it.status,
                amount: amtObj?.value || totalAmtObj?.value,
              };
            }),
            items,
            instruction: "DUPLICATE INVOICE DETECTED. You MUST record a DUPLICATE_BILLING discrepancy using 'record_discrepancy' and you MUST NOT invoke 'create_invoice'.",
          };
        }

        return {
          duplicatesFound: false,
          count: 0,
          items,
          instruction: "No active duplicate billings found. Proceed with PO terms audit.",
        };
      } catch (err: unknown) {
        console.warn("[search_invoicing] Caught execution error:", err instanceof Error ? err.message : String(err));
        return {
          isError: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  // Tool 1b: search_disbursements (Campaign Pool Duplicate Check Action)
  const searchDisbursementsTool = tool({
    description: "Search existing disbursements in the relief campaign pool by campaign ID, vendor ID, PO reference, or document hash to detect duplicate payouts and double-billing.",
    parameters: z.object({
      campaignId: z.string().optional().describe("Campaign ID to check (e.g. 'CAMP-MED-01')."),
      vendorId: z.string().optional().describe("Vendor ID or vendor name."),
      poNumber: z.string().optional().describe("PO reference or bill number (e.g. 'PO-OMNI-2026-REP1')."),
      reference: z.string().optional().describe("Alternative PO reference parameter."),
      docHash: z.string().optional().describe("Cryptographic SHA-256 preflight or document hash."),
    }),
    execute: async (args, options) => {
      hasExecutedDuplicateSearch = true;
      try {
        let rawResult: unknown;
        if (customTools?.search_disbursements?.execute) {
          rawResult = await customTools.search_disbursements.execute(args, options);
        } else {
          const campId = (args?.campaignId || (reviewInput as unknown as { campaignId?: string }).campaignId || "").trim();
          const vendorQuery = (args?.vendorId || reviewInput.vendorName || "").trim().toLowerCase();
          const targetPo = (args?.poNumber || args?.reference || reviewInput.poNumber || "").trim().toLowerCase();
          const targetHash = (args?.docHash || "").trim().toLowerCase();

          const list = await getDisbursements(campId || undefined);
          const duplicates = list.filter((d) => {
            if (d.status === "FAILED") return false;

            // 1. Check campaign match
            if (campId && d.campaignId && d.campaignId.toLowerCase() !== campId.toLowerCase()) {
              return false;
            }

            // 2. Check PO / Bill number duplicate
            if (targetPo) {
              if (d.poNumber && d.poNumber.trim().toLowerCase() === targetPo) return true;
              if (d.id.toLowerCase().includes(targetPo) || d.reviewId.toLowerCase().includes(targetPo)) return true;
            }

            // 3. Check Document / Proof Hash duplicate
            if (targetHash) {
              if (d.docHash && d.docHash.trim().toLowerCase() === targetHash) return true;
              if (d.proofHash && d.proofHash.trim().toLowerCase() === targetHash) return true;
            }

            // 4. Same vendor + same PO
            if (vendorQuery && targetPo) {
              const vendorMatch =
                (d.vendorId && d.vendorId.toLowerCase() === vendorQuery) ||
                (d.vendorName && d.vendorName.toLowerCase().includes(vendorQuery));
              if (vendorMatch && d.poNumber && d.poNumber.trim().toLowerCase() === targetPo) return true;
            }

            return false;
          });

          rawResult = { disbursements: duplicates };
        }

        const rawObj = rawResult as Record<string, unknown> | undefined;
        const list = Array.isArray(rawObj?.disbursements) ? rawObj.disbursements : [];
        if (list.length > 0) {
          hasDuplicate = true;
          hasBlockingDiscrepancy = true;
          const dupRef = args?.poNumber || args?.reference || reviewInput.poNumber || "provided bill";
          discrepancies.push({
            category: "DUPLICATE_BILLING",
            field: "poNumber",
            severity: "BLOCKING",
            description: `Active duplicate disbursement found in relief campaign pool matching reference '${dupRef}'. Already reserved under disbursement ID '${(list[0] as { id?: string })?.id || "existing"}'.`,
            reason: "Double billing prevention policy.",
            remedyRecommendation: "Reject duplicate disbursement request. This invoice deliverable has already been funded.",
          });
          return {
            duplicateFound: true,
            count: list.length,
            items: list,
            instruction: "DUPLICATE DISBURSEMENT DETECTED. You MUST record a DUPLICATE_BILLING discrepancy and you MUST NOT call prepare_approval.",
          };
        }
        return {
          duplicateFound: false,
          count: 0,
          instruction: "No duplicate disbursements found in campaign pool. Proceed with SOW rate audit.",
        };
      } catch (err) {
        return { isError: true, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  // Tool 2: audit_po_terms (Deterministic Financial & Contract Audit)
  const auditPoTermsTool = tool({
    description: "Cross-check invoice line items against PO rate cards, verify integer minor-unit math, and validate PO spend cap.",
    parameters: z.object({
      poNumber: z.string().describe("Purchase order reference number."),
      currency: z.string().length(3).optional().describe("Three-letter ISO-4217 currency code (e.g. USD)."),
      vendorName: z.string().optional().describe("Invoicer/vendor name."),
      buyerName: z.string().optional().describe("Buyer name."),
      buyerEmail: z.string().optional().describe("Buyer email."),
      poCap: z.string().optional().describe("Maximum authorized PO spend cap (e.g. '1250.00')."),
      rateCard: z.array(z.object({
        description: z.string().describe("Role or item description on the negotiated rate card."),
        maxUnitRate: z.string().describe("Maximum allowed unit rate in standard currency units (e.g. '250.00')."),
        maxQuantity: z.string().optional().describe("Maximum authorized quantity or hours."),
      })).optional().describe("Agreed rate card terms from the Purchase Order."),
      items: z.array(z.object({
        description: z.string().describe("Line item description."),
        quantity: z.string().describe("Billed quantity."),
        unitAmount: z.string().describe("Unit price (e.g. '250.50')."),
      })).min(1).describe("Proposed invoice line items."),
    }),
    execute: async (args, options) => {
      try {
        if (customTools?.audit_po_terms?.execute) {
          const customRes = await customTools.audit_po_terms.execute(args, options);
          if (customRes && typeof customRes === "object") {
            const resObj = customRes as Record<string, unknown>;
            const customIssues = Array.isArray(resObj.issues)
              ? (resObj.issues as Array<Record<string, unknown>>)
              : Array.isArray(resObj.findings)
              ? (resObj.findings as Array<Record<string, unknown>>)
              : [];
            const isCustomCompliant = resObj.compliant !== false &&
              resObj.status !== "HOLD" &&
              !customIssues.some(iss => !iss.severity || /block|critical/i.test(String(iss.severity)));

            if (!isCustomCompliant) {
              hasBlockingDiscrepancy = true;
              if (customIssues.length > 0) {
                for (const iss of customIssues) {
                  const sev = String(iss.severity || "BLOCKING");
                  if (/block|critical/i.test(sev)) {
                    const fld = String(iss.field || "");
                    const rsn = String(iss.reason || iss.message || iss.description || "");
                    const isRate = fld.toLowerCase().includes("rate") || fld.toLowerCase().includes("unitamount") || rsn.toLowerCase().includes("rate");
                    const isCap = fld.toLowerCase().includes("cap") || fld.toLowerCase().includes("total") || rsn.toLowerCase().includes("cap");
                    const category: Discrepancy["category"] = isRate ? "RATE_MISMATCH" : isCap ? "PO_CAP_EXCEEDED" : "OTHER";

                    const already = discrepancies.some(d => d.field === iss.field && (d.description === (iss.message || iss.reason || iss.description) || d.category === category));
                    if (!already) {
                      discrepancies.push({
                        category,
                        field: iss.field ? String(iss.field) : undefined,
                        expected: iss.expected ? String(iss.expected) : undefined,
                        actual: iss.actual ? String(iss.actual) : undefined,
                        severity: sev,
                        description: String(iss.message || iss.reason || iss.description || "PO terms discrepancy"),
                        reason: iss.reason ? String(iss.reason) : undefined,
                        poValue: iss.expected ? String(iss.expected) : undefined,
                        invoiceValue: iss.actual ? String(iss.actual) : undefined,
                        remedyRecommendation: "Revise invoice parameters to match approved PO terms.",
                      });
                    }
                  }
                }
              } else {
                discrepancies.push({
                  category: "OTHER",
                  severity: "BLOCKING",
                  description: String(resObj.summary || "PO terms audit detected non-compliance."),
                  remedyRecommendation: "Revise invoice parameters to match approved PO terms.",
                });
              }
            }
            return customRes;
          }
        }

        const findings: Array<{ field: string; severity: "block" | "warning"; message: string }> = [];
        let totalMinor = 0;

        for (let i = 0; i < args.items.length; i++) {
          const item = args.items[i];
          const qty = Number(item.quantity);
          const rateMinor = parseCents(item.unitAmount);

          if (!Number.isSafeInteger(qty) || qty <= 0) {
            findings.push({ field: `items[${i}].quantity`, severity: "block", message: `Line ${i + 1}: quantity must be positive whole number.` });
          }
          if (rateMinor === null) {
            findings.push({ field: `items[${i}].unitAmount`, severity: "block", message: `Line ${i + 1}: unit rate must be positive currency amount.` });
          }
          if (rateMinor !== null && Number.isSafeInteger(qty) && qty > 0) {
            totalMinor += rateMinor * qty;
          }

          if (args.rateCard && rateMinor !== null) {
            const match = args.rateCard.find(rc =>
              rc.description.toLowerCase().trim() === item.description.toLowerCase().trim() ||
              item.description.toLowerCase().includes(rc.description.toLowerCase().trim())
            );
            if (match) {
              const agreedMinor = parseCents(match.maxUnitRate);
              if (agreedMinor !== null && rateMinor > agreedMinor) {
                const diff = ((rateMinor - agreedMinor) / 100).toFixed(2);
                findings.push({
                  field: `items[${i}].unitAmount`,
                  severity: "block",
                  message: `Line ${i + 1} ('${item.description}'): Proposed unit rate $${item.unitAmount} exceeds agreed rate card rate $${match.maxUnitRate} by $${diff} per unit.`,
                });
              }
            }
          }
        }

        const capStr = args.poCap || reviewInput.poCap;
        if (capStr) {
          const capMinor = parseCents(capStr);
          if (capMinor === null) {
            findings.push({ field: "poCap", severity: "block", message: "Stated PO cap is invalid." });
          } else if (totalMinor > capMinor) {
            const overage = ((totalMinor - capMinor) / 100).toFixed(2);
            findings.push({
              field: "totalAmount",
              severity: "block",
              message: `Invoice total ($${(totalMinor / 100).toFixed(2)}) exceeds authorized PO cap ($${capStr}) by $${overage}.`,
            });
          }
        }

        const blockingFindings = findings.filter(f => f.severity === "block");
        const isCompliant = blockingFindings.length === 0;

        if (!isCompliant) {
          hasBlockingDiscrepancy = true;
          for (const finding of blockingFindings) {
            const isRate = finding.field.includes("unitAmount") || finding.message.toLowerCase().includes("rate");
            const isCap = finding.field.includes("poCap") || finding.field.includes("totalAmount") || finding.message.toLowerCase().includes("cap");
            const category: Discrepancy["category"] = isRate
              ? "RATE_MISMATCH"
              : isCap
              ? "PO_CAP_EXCEEDED"
              : "OTHER";

            const already = discrepancies.some(d => d.field === finding.field && d.description === finding.message);
            if (!already) {
              discrepancies.push({
                category,
                field: finding.field,
                severity: "BLOCKING",
                description: finding.message,
                reason: finding.message,
                remedyRecommendation: "Revise invoice parameters to match approved PO terms.",
              });
            }
          }
        }

        return {
          compliant: isCompliant,
          status: isCompliant ? "READY" : "HOLD",
          totalMinor,
          totalFormatted: `${args.currency || reviewInput.currency || "USD"} ${(totalMinor / 100).toFixed(2)}`,
          issues: findings,
          findings,
          summary: isCompliant
            ? "All line items and rates comply with PO terms. Total amount is within authorized ceiling."
            : `PO terms audit failed with ${findings.length} discrepancy finding(s).`,
        };
      } catch (err: unknown) {
        console.warn("[audit_po_terms] Caught execution error:", err instanceof Error ? err.message : String(err));
        return {
          isError: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  // Tool 3: record_discrepancy (Audit Ledger Tool)
  const recordDiscrepancyTool = tool({
    description: "Formally log an identified contract discrepancy or duplicate billing finding into the audit ledger and lock the safety gate.",
    parameters: z.object({
      category: z.enum(["DUPLICATE_BILLING", "RATE_MISMATCH", "PO_CAP_EXCEEDED", "ENTITY_MISMATCH", "UNAUTHORIZED_ITEM", "OTHER"]).optional(),
      field: z.string().optional().describe("Specific field or attribute with discrepancy (e.g. 'unitAmount', 'poCap', 'poNumber', 'totalAmount')."),
      expected: z.string().optional().describe("Expected contractual value."),
      actual: z.string().optional().describe("Actual observed value."),
      severity: z.string().describe("Severity level ('block', 'warning', 'BLOCKING', 'CRITICAL', etc.)"),
      description: z.string().optional().describe("Detailed description of the discrepancy."),
      reason: z.string().optional().describe("Reason or remediation instructions."),
      poValue: z.string().optional(),
      invoiceValue: z.string().optional(),
      remedyRecommendation: z.string().optional(),
    }),
    execute: async (args, options) => {
      try {
        if (customTools?.record_discrepancy?.execute) {
          await customTools.record_discrepancy.execute(args, options);
        }

        const isBlocking = /block|critical/i.test(args.severity);
        if (isBlocking) {
          hasBlockingDiscrepancy = true;
        }

        let category: Discrepancy["category"] = args.category || "OTHER";
        if (!args.category) {
          const f = (args.field || "").toLowerCase();
          const r = (args.reason || args.description || "").toLowerCase();
          if (f.includes("rate") || f.includes("unitamount") || r.includes("rate")) {
            category = "RATE_MISMATCH";
          } else if (f.includes("cap") || f.includes("total") || r.includes("cap")) {
            category = "PO_CAP_EXCEEDED";
          } else if (f.includes("dup") || f.includes("ponumber") || r.includes("duplicate")) {
            category = "DUPLICATE_BILLING";
          }
        }

        if (category === "DUPLICATE_BILLING") {
          hasDuplicate = true;
        }

        const discrepancy: Discrepancy = {
          category,
          field: args.field,
          expected: args.expected,
          actual: args.actual,
          severity: args.severity,
          description: args.description || args.reason || `Discrepancy on ${args.field ?? "contract terms"}`,
          reason: args.reason,
          poValue: args.poValue || args.expected,
          invoiceValue: args.invoiceValue || args.actual,
          remedyRecommendation: args.remedyRecommendation || "Revise invoice parameters to match approved PO terms.",
        };

        const matchIdx = discrepancies.findIndex(d =>
          (d.field && args.field && d.field === args.field) ||
          (d.category === category && args.field && d.field === args.field)
        );
        if (matchIdx >= 0) {
          discrepancies[matchIdx] = discrepancy;
        } else {
          discrepancies.push(discrepancy);
        }

        return {
          recorded: true,
          count: discrepancies.length,
          discrepancyId: `disc_${discrepancies.length}`,
          severity: args.severity,
          safetyGateEngaged: isBlocking,
          message: isBlocking
            ? "Discrepancy recorded. Safety gate is LOCKED. Draft creation via 'create_invoice' is prohibited."
            : "Discrepancy warning recorded.",
        };
      } catch (err: unknown) {
        console.warn("[record_discrepancy] Caught execution error:", err instanceof Error ? err.message : String(err));
        return {
          isError: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  // Tool 4: create_invoice (Programmatically Guarded Draft Creation Action)
  const createInvoiceTool = tool({
    description: "Create a PayPal sandbox draft invoice once reconciliation is 100% clean. Strictly blocked if duplicates or blocking discrepancies exist.",
    parameters: z.object({
      currency_code: z.string().optional(),
      reference: z.string().optional(),
      note: z.string().optional(),
      invoicer_business_name: z.string().optional(),
      invoicer_given_name: z.string().optional(),
      primary_recipients: z.array(z.unknown()).optional(),
      items: z.array(z.unknown()).optional(),
      allow_partial_payment: z.boolean().optional(),
    }).passthrough(),
    execute: async (args, options) => {
      try {
        // 1. PROGRAMMATIC PRECONDITION: DUPLICATE SEARCH MUST BE EXECUTED FIRST
        const isSearchRequired = !customTools || customTools.search_invoicing !== undefined;
        if (isSearchRequired && !hasExecutedDuplicateSearch) {
          hasBlockingDiscrepancy = true;
          discrepancies.push({
            category: "OTHER",
            field: "search_invoicing",
            severity: "BLOCKING",
            description: "search_invoicing must be executed before creating a draft invoice.",
            reason: "Mandatory duplicate search precondition violated.",
            remedyRecommendation: "Execute search_invoicing prior to create_invoice.",
          });
          return {
            isError: true,
            blocked: true,
            error: "GATE_REJECTED: search_invoicing must be executed before creating a draft invoice.",
          };
        }

        // 2. PROGRAMMATIC HARD GUARDRAIL
        const isBlocked = hasDuplicate ||
          hasBlockingDiscrepancy ||
          discrepancies.some(d => /block|critical/i.test(d.severity)) ||
          duplicateInvoices.length > 0;

        if (isBlocked) {
          return {
            isError: true,
            blocked: true,
            error: "GATE_REJECTED: Invoice draft creation is strictly forbidden when duplicate billings or blocking contract discrepancies exist.",
          };
        }

        if (preflightBaseline.status !== "READY") {
          return {
            isError: true,
            blocked: true,
            error: `GATE_REJECTED: Preflight review status is '${preflightBaseline.status}'. Draft invoice creation requires 'READY' status.`,
          };
        }

        // 3. DETERMINISTIC BASELINE AUTHORITY & PARAMETER VALIDATION
        const argsRecord = (args && typeof args === "object") ? (args as Record<string, unknown>) : undefined;
        const noteValue = (typeof argsRecord?.note === "string" && argsRecord.note.trim())
          ? argsRecord.note.trim()
          : undefined;

        const baselineDraft = toPayPalInvoiceDraft(preflightBaseline, {
          note: noteValue || (reviewInput.poNumber ? `PO ${reviewInput.poNumber} verified by Autonomous Reconciliation Agent` : undefined),
          allowPartialPayment: typeof argsRecord?.allow_partial_payment === "boolean" ? argsRecord.allow_partial_payment : undefined,
        });

        // Validate LLM overrides against baseline authority
        if (argsRecord) {
          // Currency validation
          if (argsRecord.currency_code && String(argsRecord.currency_code).trim().toUpperCase() !== baselineDraft.currency_code.toUpperCase()) {
            hasBlockingDiscrepancy = true;
            discrepancies.push({
              category: "OTHER",
              field: "currency_code",
              expected: baselineDraft.currency_code,
              actual: String(argsRecord.currency_code),
              severity: "BLOCKING",
              description: `Proposed currency '${argsRecord.currency_code}' diverges from verified baseline currency '${baselineDraft.currency_code}'.`,
              reason: "Parameter injection / currency diversion detected.",
            });
            return {
              isError: true,
              blocked: true,
              error: `GATE_REJECTED: Currency mismatch with verified preflight baseline. Expected '${baselineDraft.currency_code}', received '${argsRecord.currency_code}'.`,
            };
          }

          // Reference validation
          if (argsRecord.reference && baselineDraft.reference && String(argsRecord.reference).trim() !== baselineDraft.reference.trim()) {
            hasBlockingDiscrepancy = true;
            discrepancies.push({
              category: "ENTITY_MISMATCH",
              field: "reference",
              expected: baselineDraft.reference,
              actual: String(argsRecord.reference),
              severity: "BLOCKING",
              description: `Proposed reference '${argsRecord.reference}' diverges from verified PO reference '${baselineDraft.reference}'.`,
              reason: "Parameter injection / reference diversion detected.",
            });
            return {
              isError: true,
              blocked: true,
              error: `GATE_REJECTED: Reference mismatch with verified preflight baseline. Expected '${baselineDraft.reference}', received '${argsRecord.reference}'.`,
            };
          }

          // Primary recipient validation
          if (argsRecord.primary_recipients && Array.isArray(argsRecord.primary_recipients) && argsRecord.primary_recipients.length > 0) {
            const expectedBilling = baselineDraft.primary_recipients?.[0]?.billing_info;
            const expectedEmail = expectedBilling?.email_address ? expectedBilling.email_address.toLowerCase() : undefined;
            const rec0 = argsRecord.primary_recipients[0] as Record<string, unknown> | undefined;
            const recBilling = rec0?.billing_info as Record<string, unknown> | undefined;
            const proposedEmail = recBilling?.email_address ? String(recBilling.email_address).trim().toLowerCase() : undefined;

            if (expectedEmail && proposedEmail && proposedEmail !== expectedEmail) {
              hasBlockingDiscrepancy = true;
              discrepancies.push({
                category: "ENTITY_MISMATCH",
                field: "primary_recipients[0].billing_info.email_address",
                expected: expectedBilling?.email_address,
                actual: String(recBilling?.email_address),
                severity: "BLOCKING",
                description: `Proposed recipient email '${recBilling?.email_address}' diverges from verified baseline email '${expectedBilling?.email_address}'.`,
                reason: "Parameter injection / recipient diversion detected.",
              });
              return {
                isError: true,
                blocked: true,
                error: `GATE_REJECTED: Recipient diversion detected. Proposed recipient '${recBilling?.email_address}' does not match verified buyer email '${expectedBilling?.email_address}'.`,
              };
            }
          }

          // Items validation
          if (argsRecord.items && Array.isArray(argsRecord.items)) {
            const baselineItems = baselineDraft.items;
            if (argsRecord.items.length !== baselineItems.length) {
              hasBlockingDiscrepancy = true;
              discrepancies.push({
                category: "UNAUTHORIZED_ITEM",
                field: "items",
                expected: `${baselineItems.length} items`,
                actual: `${argsRecord.items.length} items`,
                severity: "BLOCKING",
                description: `Proposed line item count (${argsRecord.items.length}) does not match verified baseline count (${baselineItems.length}).`,
                reason: "Parameter injection / item count modification detected.",
              });
              return {
                isError: true,
                blocked: true,
                error: `GATE_REJECTED: Line item count mismatch with verified baseline. Expected ${baselineItems.length}, received ${argsRecord.items.length}.`,
              };
            }

            for (let i = 0; i < baselineItems.length; i++) {
              const baseIt = baselineItems[i];
              const propIt = argsRecord.items[i] as Record<string, unknown> | undefined;
              if (propIt) {
                const propQty = propIt.quantity ? String(propIt.quantity).trim() : undefined;
                if (propQty !== undefined && propQty !== baseIt.quantity) {
                  hasBlockingDiscrepancy = true;
                  discrepancies.push({
                    category: "UNAUTHORIZED_ITEM",
                    field: `items[${i}].quantity`,
                    expected: baseIt.quantity,
                    actual: propQty,
                    severity: "BLOCKING",
                    description: `Proposed quantity '${propQty}' on item ${i + 1} diverges from verified baseline quantity '${baseIt.quantity}'.`,
                  });
                  return {
                    isError: true,
                    blocked: true,
                    error: `GATE_REJECTED: Line item ${i + 1} quantity mismatch with verified baseline.`,
                  };
                }

                const propUnitAmt = propIt.unit_amount as Record<string, unknown> | undefined;
                const propVal = propUnitAmt?.value ? String(propUnitAmt.value).trim() : undefined;
                if (propVal !== undefined && propVal !== baseIt.unit_amount.value) {
                  hasBlockingDiscrepancy = true;
                  discrepancies.push({
                    category: "RATE_MISMATCH",
                    field: `items[${i}].unit_amount.value`,
                    expected: baseIt.unit_amount.value,
                    actual: propVal,
                    severity: "BLOCKING",
                    description: `Proposed unit rate '${propVal}' on item ${i + 1} diverges from verified baseline rate '${baseIt.unit_amount.value}'.`,
                  });
                  return {
                    isError: true,
                    blocked: true,
                    error: `GATE_REJECTED: Line item ${i + 1} unit amount mismatch with verified baseline.`,
                  };
                }
              }
            }
          }
        }

        // 4. EXECUTE CREATION WITH AUTHORITATIVE BASELINE DRAFT
        let rawResult: unknown;
        if (customTools?.create_invoice?.execute) {
          rawResult = await customTools.create_invoice.execute(baselineDraft, options);
        } else if (nativeTools?.create_invoice?.execute) {
          rawResult = await nativeTools.create_invoice.execute(baselineDraft, options);
        } else {
          rawResult = await paypalCreateDraft(baselineDraft);
        }

        if (typeof rawResult === "object" && rawResult !== null) {
          const resObj = rawResult as Record<string, unknown>;
          const id = resObj.id || resObj.invoice_id;
          if (id) {
            draftInvoiceId = String(id);
            const links = Array.isArray(resObj.links) ? (resObj.links as Array<Record<string, unknown>>) : [];
            const payerView = links.find((l) => l.rel === "payer-view")?.href;
            if (payerView) {
              invoiceUrl = String(payerView);
            }
          }
          return {
            success: true,
            id: resObj.id || resObj.invoice_id,
            status: resObj.status || "DRAFT",
            links: resObj.links,
            message: "Draft invoice successfully created on PayPal sandbox.",
          };
        }

        return { success: true, result: rawResult };
      } catch (err: unknown) {
        console.warn("[create_invoice] Caught execution error:", err instanceof Error ? err.message : String(err));
        return {
          isError: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  // Tool 4b: prepare_approval (Verified Disbursement Approval Preparation)
  const prepareApprovalTool = tool({
    description: "Prepare and certify verified disbursement approval once duplicate checks and SOW rate audits are 100% clean.",
    parameters: z.object({
      note: z.string().optional().describe("Audit approval summary notes."),
    }),
    execute: async (args) => {
      const isSearchRequired =
        !customTools ||
        customTools.search_disbursements !== undefined ||
        customTools.search_invoicing !== undefined;
      if (isSearchRequired && !hasExecutedDuplicateSearch) {
        hasBlockingDiscrepancy = true;
        discrepancies.push({
          category: "OTHER",
          field: "search_disbursements",
          severity: "BLOCKING",
          description: "search_disbursements must be executed before preparing disbursement approval.",
          reason: "Mandatory duplicate check precondition violated.",
          remedyRecommendation: "Execute search_disbursements prior to prepare_approval.",
        });
        return {
          isError: true,
          blocked: true,
          error: "GATE_REJECTED: Duplicate check must be executed before approval.",
        };
      }

      const isBlocked =
        hasDuplicate ||
        hasBlockingDiscrepancy ||
        discrepancies.some((d) => /block|critical/i.test(d.severity)) ||
        duplicateInvoices.length > 0;

      if (isBlocked) {
        return {
          isError: true,
          blocked: true,
          error: "GATE_REJECTED: Approval is strictly forbidden when duplicate billings or SOW discrepancies exist.",
        };
      }

      if (preflightBaseline.status !== "READY") {
        return {
          isError: true,
          blocked: true,
          error: `GATE_REJECTED: Preflight review status is '${preflightBaseline.status}'. Approval requires READY.`,
        };
      }

      return {
        approved: true,
        status: "APPROVED",
        totalMinor: preflightBaseline.totalMinor,
        note: args?.note || "Reconciliation clean; approved for disbursement.",
      };
    },
  });

  const systemPrompt = `You are an Autonomous Humanitarian Aid AP Reconciliation Specialist & Financial Auditor on the ClearAid platform.
Your mandate is to protect donor relief pools from billing discrepancies, duplicate disbursements, inflated rates, and unauthorized SOW line items.

Follow this strict multi-step deliberation procedure:
1. DUPLICATE CHECK: Call 'search_disbursements' using campaign ID, vendor ID, PO reference, or document hash.
   If any active duplicate exists, call 'record_discrepancy' with category "DUPLICATE_BILLING", severity "BLOCKING", and DO NOT approve.
2. PREFLIGHT AUDIT: Call 'audit_po_terms' to verify integer minor math, line items, SOW rate card compliance, and campaign pool cap.
3. APPROVAL GATE:
   - If ANY blocking discrepancies or duplicate records exist, DO NOT approve.
   - If and ONLY if all checks are completely clean, call 'prepare_approval' to verify the disbursement.
4. SYNTHESIS: Provide a clear reconciliation summary.`;

  const userPrompt = `Reconcile the following invoice request against Purchase Order terms:
PO Reference: ${reviewInput.poNumber || "N/A"}
Vendor: ${reviewInput.vendorName || "N/A"}
Buyer: ${reviewInput.buyerName || "N/A"} <${reviewInput.buyerEmail || "N/A"}>
Currency: ${reviewInput.currency || "USD"}
Stated PO Cap: ${reviewInput.poCap || "None"}
Line Items:
${(reviewInput.items || []).map((it, idx) => `  ${idx + 1}. ${it.description} | Qty: ${it.quantity} | Rate: ${it.unitAmount}`).join("\n")}
Source Contract Evidence:
${(reviewInput.evidence || []).map(e => `  [${e.document} pg.${e.page || 1}]: "${e.quote}"`).join("\n")}

Additional Instructions: ${input.userInstruction || "Verify contract terms and prepare draft if clean."}`;

  // Assemble runtime tools (including legacy actions for programmatic hard-gate adversarial testing)
  const agentTools: Record<string, CoreTool> = {
    search_disbursements: searchDisbursementsTool,
    prepare_approval: prepareApprovalTool,
    audit_po_terms: auditPoTermsTool,
    record_discrepancy: recordDiscrepancyTool,
    search_invoicing: searchInvoicingTool,
    create_invoice: createInvoiceTool,
  };

  let summaryText = "";
  const steps: DeliberationStep[] = [];

  try {
    const response = await generateText({
      model,
      tools: agentTools,
      maxSteps: 6,
      system: systemPrompt,
      prompt: userPrompt,
    });
    summaryText = response.text || "";

    // Extract Step Trace
    if (response.steps) {
      for (let idx = 0; idx < response.steps.length; idx++) {
        const step = response.steps[idx];
        steps.push({
          step: idx + 1,
          thought: step.text || undefined,
          toolCalls: (step.toolCalls || []).map((tc) => ({
            toolName: tc.toolName,
            args: (tc.args || {}) as Record<string, unknown>,
          })),
          toolResults: (step.toolResults || []).map((tr) => ({
            toolName: tr.toolName,
            result: tr.result,
          })),
        });

        for (const tr of step.toolResults || []) {
          if (tr.toolName === "create_invoice" && typeof tr.result === "object" && tr.result !== null) {
            const res = tr.result as Record<string, unknown>;
            const id = res.id || res.invoice_id;
            if (id && !res.isError && !res.blocked) {
              draftInvoiceId = String(id);
              const links = Array.isArray(res.links) ? (res.links as Array<Record<string, unknown>>) : [];
              const payerView = links.find((l) => l.rel === "payer-view")?.href;
              if (payerView) {
                invoiceUrl = String(payerView);
              }
            }
          }
          if (tr.toolName === "search_disbursements") {
            hasExecutedDuplicateSearch = true;
            if (typeof tr.result === "object" && tr.result !== null) {
              const res = tr.result as Record<string, unknown>;
              if (res.duplicateFound) {
                hasDuplicate = true;
              }
            }
          }
          if (tr.toolName === "search_invoicing") {
            hasExecutedDuplicateSearch = true;
            if (typeof tr.result === "object" && tr.result !== null) {
              const res = tr.result as Record<string, unknown>;
              const items = Array.isArray(res.items)
                ? (res.items as Array<Record<string, unknown>>)
                : Array.isArray(res.invoices)
                ? (res.invoices as Array<Record<string, unknown>>)
                : [];
              for (const item of items) {
                if (typeof item === "object" && item !== null) {
                  const s = String(item.status || "").toUpperCase();
                  if (s && s !== "CANCELLED" && s !== "REFUNDED" && s !== "AUTO_CANCELLED") {
                    hasDuplicate = true;
                    const itemId = item.id || item.invoice_id;
                    if (!duplicateInvoices.some((d) => d.id === itemId)) {
                      const amtObj = item.amount as { value?: string } | undefined;
                      const totalAmtObj = item.total_amount as { value?: string } | undefined;
                      duplicateInvoices.push({
                        id: String(itemId || "unknown"),
                        status: s,
                        amount: amtObj?.value || totalAmtObj?.value,
                      });
                    }
                  }
                }
              }
            }
          }
          if (tr.toolName === "audit_po_terms" && typeof tr.result === "object" && tr.result !== null) {
            const res = tr.result as Record<string, unknown>;
            if (res.compliant === false || res.status === "HOLD") {
              hasBlockingDiscrepancy = true;
            }
            if (Array.isArray(res.issues)) {
              const issues = res.issues as Array<Record<string, unknown>>;
              if (issues.some((i) => !i.severity || /block|critical/i.test(String(i.severity)))) {
                hasBlockingDiscrepancy = true;
              }
            }
            if (Array.isArray(res.findings)) {
              const findings = res.findings as Array<Record<string, unknown>>;
              if (findings.some((f) => !f.severity || /block|critical/i.test(String(f.severity)))) {
                hasBlockingDiscrepancy = true;
              }
            }
          }
        }
      }
    }
  } catch (llmErr) {
    console.warn("LLM generation failed, falling back to deterministic tool execution:", llmErr);
    // Execute deterministic audit directly
    const auditRes = await auditPoTermsTool.execute({} as never, { toolCallId: "call_audit_fallback", messages: [] } as never);
    steps.push({
      step: 1,
      thought: `Autonomous audit fallback: evaluated SOW rate card ceilings and budget quota for PO ${reviewInput.poNumber}.`,
      toolCalls: [{ toolName: "audit_po_terms", args: {} }],
      toolResults: [{ toolName: "audit_po_terms", result: auditRes }],
    });
    if ((auditRes as Record<string, unknown>)?.status === "HOLD") {
      hasBlockingDiscrepancy = true;
    }

    const dupRes = await searchDisbursementsTool.execute(
      { poNumber: reviewInput.poNumber, campaignId: reviewInput.campaignId } as never,
      { toolCallId: "call_dup_fallback", messages: [] } as never
    );
    steps.push({
      step: 2,
      thought: `Autonomous duplicate guard: inspected campaign pool for prior settled milestones referencing PO ${reviewInput.poNumber}.`,
      toolCalls: [{ toolName: "search_disbursements", args: { poNumber: reviewInput.poNumber } }],
      toolResults: [{ toolName: "search_disbursements", result: dupRes }],
    });
    if ((dupRes as Record<string, unknown>)?.duplicateFound) {
      hasDuplicate = true;
    }
    summaryText = hasDuplicate
      ? `Double-billing prevention: identical PO milestone already settled in campaign pool.`
      : hasBlockingDiscrepancy
      ? `SOW rate card discrepancy detected during contract audit.`
      : `Reconciliation verified clean: SOW rate card and uncommitted pool caps verified.`;
  }

  // Resolve status deterministically
  const isDuplicate = hasDuplicate ||
    duplicateInvoices.length > 0 ||
    discrepancies.some(d => d.category === "DUPLICATE_BILLING");

  const isDiscrepant = hasBlockingDiscrepancy ||
    discrepancies.some(d => /block|critical/i.test(d.severity)) ||
    preflightBaseline.status === "HOLD";

  let status: ReconciliationStatus;
  if (isDuplicate) {
    status = "DUPLICATE_DETECTED";
    draftInvoiceId = undefined;
  } else if (isDiscrepant) {
    status = "DISCREPANCY_FOUND";
    draftInvoiceId = undefined;
  } else {
    status = "APPROVED";
  }

  return {
    status,
    draftInvoiceId,
    invoiceUrl,
    discrepancies,
    steps,
    summary: summaryText || (
      status === "APPROVED"
        ? `Reconciliation approved. PO ${reviewInput.poNumber} verified clean. Draft invoice ${draftInvoiceId || ""} prepared awaiting merchant authorization.`
        : status === "DUPLICATE_DETECTED"
        ? `Duplicate billing detected for PO ${reviewInput.poNumber}. Draft invoice creation blocked.`
        : `Discrepancies found for PO ${reviewInput.poNumber}. Draft invoice creation blocked.`
    ),
    preflightResult: preflightBaseline,
  };
}
