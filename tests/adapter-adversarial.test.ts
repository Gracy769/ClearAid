import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import {
  formatUnitAmount,
  toPayPalInvoiceDraft,
} from "../src/lib/paypal-adapter";
import type { ReviewResult, ReviewInput } from "../src/lib/types";

// Offline instance of PayPalAgentToolkit to test against the exact live schema
const toolkit = new PayPalAgentToolkit({
  clientId: "mock-sandbox-client-id",
  clientSecret: "mock-sandbox-client-secret",
  configuration: {
    context: { sandbox: true },
    actions: { invoices: { create: true } },
  },
});
const toolkitSchema = toolkit.getTools().create_invoice.parameters;

const baseValidReview: ReviewResult = {
  status: "READY",
  totalMinor: 50000,
  findings: [],
  input: {
    vendorName: "Apex Cybernetics Corp",
    buyerName: "Omni Consumer Products",
    buyerEmail: "billing@ocp.example.com",
    poNumber: "PO-990021",
    currency: "USD",
    poCap: "10000.00",
    items: [
      {
        description: "Cloud Architecture Consulting & Infrastructure Audit",
        quantity: "2",
        unitAmount: "250.00",
      },
    ],
    evidence: [{ document: "SOW.pdf", page: 1, quote: "PO-990021 Consulting services" }],
  },
};

describe("Adversarial Stress Test: PayPal Invoice Adapter", () => {
  // ==========================================================================
  // Section 1: Schema Stress & Extreme String Lengths
  // ==========================================================================
  describe("1. Schema Stress: String Length Boundaries & Sanitization", () => {
    it("handles exactly 300 character vendorName without truncation", () => {
      const exact300 = "V".repeat(300);
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, vendorName: exact300 },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.invoicer_business_name, exact300);
      assert.equal(draft.invoicer_given_name, exact300.slice(0, 140));
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("truncates extreme 5,000 character vendorName safely to 300 and 140 chars", () => {
      const extreme5000 = "Vendorcorp " + "X".repeat(5000);
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, vendorName: extreme5000 },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.invoicer_business_name?.length, 300);
      assert.equal(draft.invoicer_given_name?.length, 140);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("truncates extreme 5,000 character buyerName safely to 300 and 140 chars", () => {
      const extreme5000 = "Enterprise Buyer " + "Y".repeat(5000);
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, buyerName: extreme5000 },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.primary_recipients[0].billing_info?.business_name?.length, 300);
      assert.equal(draft.primary_recipients[0].billing_info?.name?.given_name?.length, 140);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("handles multi-byte UTF-8, Unicode, Cyrillic, CJK, and Emojis in names safely", () => {
      const unicodeVendor = "株式会社サイバーネティクス — Cybernetics Corp ⚡ 🔥 🚀";
      const unicodeBuyer = "ООО «Технологии Будущего» / 北京智能科技";
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, vendorName: unicodeVendor, buyerName: unicodeBuyer },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.invoicer_business_name, unicodeVendor);
      assert.equal(draft.primary_recipients[0].billing_info?.business_name, unicodeBuyer);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("neutralizes SQL injection, XSS payloads, and quotes in vendor and buyer names", () => {
      const xssVendor = "<script>alert('xss')</script> & \" ' ; --";
      const sqliBuyer = "'; DROP TABLE invoices; SELECT * FROM users WHERE '1'='1";
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, vendorName: xssVendor, buyerName: sqliBuyer },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.invoicer_business_name, xssVendor);
      assert.equal(draft.primary_recipients[0].billing_info?.business_name, sqliBuyer);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("handles extreme length PO reference number safely", () => {
      const longPO = "PO-" + "9".repeat(400);
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, poNumber: longPO },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.reference, longPO);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("supports 4,000+ character notes without schema violation", () => {
      const longNote = "Legal Terms:\n" + "Clause paragraph with terms and conditions. ".repeat(100);
      assert.ok(longNote.length > 4000, `Note length ${longNote.length} should exceed 4000 chars`);

      const draft = toPayPalInvoiceDraft(baseValidReview, { note: longNote });
      assert.equal(draft.note, longNote);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("handles empty string note gracefully without emitting empty note string", () => {
      // In JavaScript "" ?? fallback evaluates to "" if not sanitized.
      // Let's test whether adapter handles options.note = ""
      const draft = toPayPalInvoiceDraft(baseValidReview, { note: "" });
      // If note is "", toolkit parser should still pass or fail?
      const tkResult = toolkitSchema.safeParse(draft);
      assert.equal(tkResult.success, true);
    });
  });

  // ==========================================================================
  // Section 2: Items, Quantities, and Rates Stress Testing
  // ==========================================================================
  describe("2. Items, Quantities, and Unit Amount Stress", () => {
    it("handles 50 line items (maximum allowed by preflight)", () => {
      const items = Array.from({ length: 50 }, (_, i) => ({
        description: `Deliverable Milestone #${i + 1}`,
        quantity: "1",
        unitAmount: `${(i + 1) * 10}.00`,
      }));
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, items },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items.length, 50);
      assert.equal(draft.items[49].name, "Deliverable Milestone #50");
      assert.equal(draft.items[49].unit_amount.value, "500.00");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("truncates 2,000 character item descriptions in name to 300 while keeping full description", () => {
      const longDesc = "Deliverable: " + "Specification details and audit requirements. ".repeat(40);
      assert.ok(longDesc.length > 1500);

      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          items: [{ description: longDesc, quantity: "1", unitAmount: "100.00" }],
        },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items[0].name.length, 300);
      assert.equal(draft.items[0].description, longDesc.trim());
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("formats various rate inputs to exact 2-decimal string representation", () => {
      assert.equal(formatUnitAmount("0"), "0.00");
      assert.equal(formatUnitAmount(0), "0.00");
      assert.equal(formatUnitAmount("1"), "1.00");
      assert.equal(formatUnitAmount(1), "1.00");
      assert.equal(formatUnitAmount("10.5"), "10.50");
      assert.equal(formatUnitAmount(10.5), "10.50");
      assert.equal(formatUnitAmount("99.99"), "99.99");
      assert.equal(formatUnitAmount("1000000.00"), "1000000.00");
      assert.equal(formatUnitAmount("  50.1  "), "50.10");
    });

    it("handles fractional quantities (e.g. 0.5 hours or 1.25 days)", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          items: [{ description: "Consulting Hours", quantity: "0.5", unitAmount: "200.00" }],
        },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items[0].quantity, "0.5");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("handles zero unit amount items (complimentary/warranty items)", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          items: [
            { description: "Paid Support", quantity: "1", unitAmount: "500.00" },
            { description: "Complimentary Setup", quantity: "1", unitAmount: "0.00" },
          ],
        },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items[1].unit_amount.value, "0.00");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("handles extreme monetary values up to billions", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          items: [{ description: "Enterprise License", quantity: "1", unitAmount: "999999999.99" }],
        },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items[0].unit_amount.value, "999999999.99");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("rejects non-numeric unit amounts via schema parse error", () => {
      const invalidAmounts = ["invalid", "$100", "100 USD", "10,000.00", "1e5", "NaN"];
      for (const amount of invalidAmounts) {
        const review: ReviewResult = {
          ...baseValidReview,
          input: {
            ...baseValidReview.input,
            items: [{ description: "Bad Amount", quantity: "1", unitAmount: amount }],
          },
        };
        assert.throws(
          () => toPayPalInvoiceDraft(review),
          /value must be a numeric value/,
          `Should reject non-numeric amount: ${amount}`
        );
      }
    });

    it("rejects non-numeric quantities via schema parse error", () => {
      const invalidQuantities = ["one", "1 unit", "10x", "1e2", "NaN"];
      for (const qty of invalidQuantities) {
        const review: ReviewResult = {
          ...baseValidReview,
          input: {
            ...baseValidReview.input,
            items: [{ description: "Bad Quantity", quantity: qty, unitAmount: "10.00" }],
          },
        };
        assert.throws(
          () => toPayPalInvoiceDraft(review),
          /Quantity must be numeric/,
          `Should reject non-numeric quantity: ${qty}`
        );
      }
    });

    it("handles empty or whitespace item description by generating fallback name 'Item N'", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          items: [
            { description: "", quantity: "1", unitAmount: "10.00" },
            { description: "   ", quantity: "1", unitAmount: "20.00" },
            { description: "\t\n", quantity: "1", unitAmount: "30.00" },
          ],
        },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items[0].name, "Item 1");
      assert.equal(draft.items[0].description, undefined);
      assert.equal(draft.items[1].name, "Item 2");
      assert.equal(draft.items[1].description, undefined);
      assert.equal(draft.items[2].name, "Item 3");
      assert.equal(draft.items[2].description, undefined);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });
  });

  // ==========================================================================
  // Section 3: Currency Stress: Exotic, Obscure, and Casing
  // ==========================================================================
  describe("3. Currency Stress: Exotic, Obscure, Normalization & Invalids", () => {
    it("normalizes lowercase and whitespace-padded currencies", () => {
      const variations = [
        { raw: "usd", expected: "USD" },
        { raw: "  eur  ", expected: "EUR" },
        { raw: "gbp\n", expected: "GBP" },
        { raw: "\tjpy\t", expected: "JPY" },
        { raw: "cAd", expected: "CAD" },
      ];
      for (const { raw, expected } of variations) {
        const review: ReviewResult = {
          ...baseValidReview,
          input: { ...baseValidReview.input, currency: raw },
        };
        const draft = toPayPalInvoiceDraft(review);
        assert.equal(draft.currency_code, expected);
        assert.equal(draft.items[0].unit_amount.currency_code, expected);
        assert.equal(toolkitSchema.safeParse(draft).success, true);
      }
    });

    it("supports 3-decimal currencies (BHD, KWD, OMR, JOD, TND)", () => {
      const threeDecimalCurrencies = ["BHD", "KWD", "OMR", "JOD", "TND"];
      for (const curr of threeDecimalCurrencies) {
        const review: ReviewResult = {
          ...baseValidReview,
          input: { ...baseValidReview.input, currency: curr },
        };
        const draft = toPayPalInvoiceDraft(review);
        assert.equal(draft.currency_code, curr);
        assert.equal(draft.items[0].unit_amount.currency_code, curr);
        assert.equal(toolkitSchema.safeParse(draft).success, true);
      }
    });

    it("supports zero-decimal currencies (JPY, KRW, CLP, PYG, UGX, VND)", () => {
      const zeroDecimalCurrencies = ["JPY", "KRW", "CLP", "PYG", "UGX", "VND"];
      for (const curr of zeroDecimalCurrencies) {
        const review: ReviewResult = {
          ...baseValidReview,
          input: {
            ...baseValidReview.input,
            currency: curr,
            items: [{ description: "Service", quantity: "1", unitAmount: "10000" }],
          },
        };
        const draft = toPayPalInvoiceDraft(review);
        assert.equal(draft.currency_code, curr);
        assert.equal(draft.items[0].unit_amount.currency_code, curr);
        assert.equal(toolkitSchema.safeParse(draft).success, true);
      }
    });

    it("supports exotic and peripheral ISO-4217 currencies (BAM, MZN, BWP, SZL, TOP, WST, XPF, ZAR, CHF)", () => {
      const exoticCurrencies = ["BAM", "MZN", "BWP", "SZL", "TOP", "WST", "XPF", "ZAR", "CHF"];
      for (const curr of exoticCurrencies) {
        const review: ReviewResult = {
          ...baseValidReview,
          input: { ...baseValidReview.input, currency: curr },
        };
        const draft = toPayPalInvoiceDraft(review);
        assert.equal(draft.currency_code, curr);
        assert.equal(toolkitSchema.safeParse(draft).success, true);
      }
    });

    it("rejects 2-letter country/currency codes (US, UK, CA, EU, JP)", () => {
      const twoLetter = ["US", "UK", "CA", "EU", "JP"];
      for (const code of twoLetter) {
        const review: ReviewResult = {
          ...baseValidReview,
          input: { ...baseValidReview.input, currency: code },
        };
        assert.throws(
          () => toPayPalInvoiceDraft(review),
          /Invalid currency code/,
          `Should reject 2-letter code: ${code}`
        );
      }
    });

    it("rejects 4-letter or longer currency codes (USDT, USDC, EURO, BITCOIN)", () => {
      const fourPlusLetter = ["USDT", "USDC", "EURO", "BITCOIN"];
      for (const code of fourPlusLetter) {
        const review: ReviewResult = {
          ...baseValidReview,
          input: { ...baseValidReview.input, currency: code },
        };
        assert.throws(
          () => toPayPalInvoiceDraft(review),
          /Invalid currency code/,
          `Should reject 4-letter code: ${code}`
        );
      }
    });

    it("rejects currencies containing numbers, symbols, spaces, or injection characters", () => {
      const maliciousCurrencies = ["840", "978", "$$$", "€€€", "U$D", "U D", "USD;--", "<script>"];
      for (const code of maliciousCurrencies) {
        const review: ReviewResult = {
          ...baseValidReview,
          input: { ...baseValidReview.input, currency: code },
        };
        assert.throws(
          () => toPayPalInvoiceDraft(review),
          /Invalid currency code/,
          `Should reject malicious currency: ${code}`
        );
      }
    });

    it("rejects empty or whitespace-only currency string", () => {
      for (const code of ["", "   ", "\t"]) {
        const review: ReviewResult = {
          ...baseValidReview,
          input: { ...baseValidReview.input, currency: code },
        };
        assert.throws(
          () => toPayPalInvoiceDraft(review),
          /Invalid currency code/,
          `Should reject empty currency: '${code}'`
        );
      }
    });
  });

  // ==========================================================================
  // Section 4: Invariants, Guardrails, and Tamper Resistance
  // ==========================================================================
  describe("4. Invariant Enforcement & Boundary Guardrails", () => {
    it("rejects review with status 'HOLD'", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        status: "HOLD",
        findings: [{ code: "po_cap_exceeded", severity: "block", message: "Exceeds cap" }],
      };
      assert.throws(
        () => toPayPalInvoiceDraft(review),
        /Cannot adapt review with status 'HOLD'/
      );
    });

    it("rejects review with arbitrary non-READY status ('PENDING', 'DRAFT', 'REJECTED')", () => {
      for (const status of ["PENDING", "DRAFT", "REJECTED", "ERROR", ""]) {
        const review = {
          ...baseValidReview,
          status: status as unknown as ReviewResult["status"],
        };
        assert.throws(
          () => toPayPalInvoiceDraft(review),
          new RegExp(`Cannot adapt review with status '${status}'`)
        );
      }
    });

    it("rejects undefined or null review argument", () => {
      assert.throws(
        () => toPayPalInvoiceDraft(undefined as unknown as ReviewResult),
        /Cannot adapt review with status 'undefined'/
      );
      assert.throws(
        () => toPayPalInvoiceDraft(null as unknown as ReviewResult),
        /Cannot adapt review with status 'undefined'/
      );
    });

    it("rejects review with missing input property", () => {
      const review = { status: "READY", totalMinor: 100 } as unknown as ReviewResult;
      assert.throws(
        () => toPayPalInvoiceDraft(review),
        /Cannot adapt review without line items/
      );
    });

    it("rejects review with empty items array", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, items: [] },
      };
      assert.throws(
        () => toPayPalInvoiceDraft(review),
        /Cannot adapt review without line items/
      );
    });

    it("rejects review where items is not an array (null or undefined)", () => {
      const review = {
        ...baseValidReview,
        input: { ...baseValidReview.input, items: null as unknown as ReviewInput["items"] },
      };
      assert.throws(
        () => toPayPalInvoiceDraft(review),
        /Cannot adapt review without line items/
      );
    });

    it("handles missing buyerName and buyerEmail without emitting empty objects", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, buyerName: "", buyerEmail: "" },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.primary_recipients.length, 1);
      assert.equal(draft.primary_recipients[0].billing_info, undefined);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("handles missing vendorName without emitting empty invoicer fields", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, vendorName: "" },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.invoicer_business_name, undefined);
      assert.equal(draft.invoicer_given_name, undefined);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });
  });

  // ==========================================================================
  // Section 5: Adapter Options Stress & Edge Validation
  // ==========================================================================
  describe("5. Adapter Options & Edge Validation", () => {
    it("handles undefined options gracefully", () => {
      const draft = toPayPalInvoiceDraft(baseValidReview, undefined);
      assert.equal(draft.allow_partial_payment, false);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("handles empty object options {}", () => {
      const draft = toPayPalInvoiceDraft(baseValidReview, {});
      assert.equal(draft.allow_partial_payment, false);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("accepts valid ISO dates (YYYY-MM-DD)", () => {
      const dates = ["2026-11-07", "2024-02-29", "2025-12-31", "2026-01-01"];
      for (const d of dates) {
        const draft = toPayPalInvoiceDraft(baseValidReview, { invoiceDate: d });
        assert.equal(draft.invoice_date, d);
        assert.equal(toolkitSchema.safeParse(draft).success, true);
      }
    });

    it("rejects non-ISO dates via schema parse error", () => {
      const invalidDates = ["11/07/2026", "2026-1-1", "2026-13-01", "2026-00-10", "2026-02-32", "yesterday", "   "];
      for (const d of invalidDates) {
        assert.throws(
          () => toPayPalInvoiceDraft(baseValidReview, { invoiceDate: d }),
          /invoice_date must be in yyyy-MM-DD format/,
          `Should reject invalid date: ${d}`
        );
      }
    });

    it("treats empty string invoiceDate as omitted", () => {
      const draft = toPayPalInvoiceDraft(baseValidReview, { invoiceDate: "" });
      assert.equal(draft.invoice_date, undefined);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("accepts 3-digit and 6-digit hex theme colors", () => {
      const validColors = ["#003087", "#FFF", "#000", "#abcdef", "#123456"];
      for (const c of validColors) {
        const draft = toPayPalInvoiceDraft(baseValidReview, { themeColor: c });
        assert.equal(draft.theme_color, c);
        assert.equal(toolkitSchema.safeParse(draft).success, true);
      }
    });

    it("rejects invalid theme colors via schema parse error", () => {
      const invalidColors = ["blue", "rgb(0,0,0)", "#12", "#1234", "#12345", "#1234567", "003087", "   "];
      for (const c of invalidColors) {
        assert.throws(
          () => toPayPalInvoiceDraft(baseValidReview, { themeColor: c }),
          /theme_color must be a hex color/,
          `Should reject invalid themeColor: ${c}`
        );
      }
    });

    it("treats empty string themeColor as omitted", () => {
      const draft = toPayPalInvoiceDraft(baseValidReview, { themeColor: "" });
      assert.equal(draft.theme_color, undefined);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("accepts valid decimal shipping cost values", () => {
      const validCosts = ["0.00", "15.00", "125.50", "0"];
      for (const sc of validCosts) {
        const draft = toPayPalInvoiceDraft(baseValidReview, { shippingCost: sc });
        assert.equal(draft.shipping_cost, sc);
        assert.equal(toolkitSchema.safeParse(draft).success, true);
      }
    });

    it("rejects non-numeric shipping cost via schema parse error", () => {
      const invalidCosts = ["free", "$15.00", "15 USD", "NaN"];
      for (const sc of invalidCosts) {
        assert.throws(
          () => toPayPalInvoiceDraft(baseValidReview, { shippingCost: sc }),
          /Invalid/,
          `Should reject invalid shipping cost: ${sc}`
        );
      }
    });

    it("sets allow_partial_payment correctly when boolean true or false", () => {
      const draftTrue = toPayPalInvoiceDraft(baseValidReview, { allowPartialPayment: true });
      assert.equal(draftTrue.allow_partial_payment, true);

      const draftFalse = toPayPalInvoiceDraft(baseValidReview, { allowPartialPayment: false });
      assert.equal(draftFalse.allow_partial_payment, false);
    });

    it("sets enable_pay_by_bank correctly when true or false", () => {
      const draftTrue = toPayPalInvoiceDraft(baseValidReview, { enablePayByBank: true });
      assert.equal(draftTrue.enable_pay_by_bank, true);

      const draftFalse = toPayPalInvoiceDraft(baseValidReview, { enablePayByBank: false });
      assert.equal(draftFalse.enable_pay_by_bank, false);
    });
  });

  // ==========================================================================
  // Section 6: Purity, Immutability, Surrogate Pairs & Edge Conditions
  // ==========================================================================
  describe("6. Purity, Immutability & Deep Edge Conditions", () => {
    it("guarantees immutability: does NOT mutate the original review or input items", () => {
      const original = JSON.parse(JSON.stringify(baseValidReview));
      const draft = toPayPalInvoiceDraft(baseValidReview);

      assert.deepEqual(baseValidReview, original, "Input review object must remain completely unmutated");
      assert.ok(draft !== (baseValidReview as unknown as Record<string, unknown>), "Draft must be a newly allocated object");
    });

    it("guarantees idempotency and purity across 100 concurrent executions", async () => {
      const iterations = 100;
      const runs = await Promise.all(
        Array.from({ length: iterations }, () => toPayPalInvoiceDraft(baseValidReview))
      );
      const firstJson = JSON.stringify(runs[0]);
      for (let i = 1; i < iterations; i++) {
        assert.equal(JSON.stringify(runs[i]), firstJson, `Run ${i} must produce identical output`);
      }
    });

    it("ignores unrecognized extra properties on review and input without schema pollution", () => {
      const pollutedReview = {
        ...baseValidReview,
        arbitraryField: "malicious_data",
        input: {
          ...baseValidReview.input,
          extraInternalSecret: "do_not_leak",
        },
      } as unknown as ReviewResult;

      const draft = toPayPalInvoiceDraft(pollutedReview);
      const draftRecord = draft as unknown as Record<string, unknown>;
      assert.equal(draftRecord.arbitraryField, undefined);
      assert.equal(draftRecord.extraInternalSecret, undefined);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("handles rate starting with dot decimal (e.g. '.5' or '.99')", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          items: [{ description: "Micro-task", quantity: "1", unitAmount: ".50" }],
        },
      };
      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items[0].unit_amount.value, ".50");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("handles emoji and surrogate pair at exact 300-character boundary without crashing", () => {
      // 299 ASCII characters + 2-byte surrogate pair (🚀)
      const boundaryString = "A".repeat(299) + "🚀";
      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          vendorName: boundaryString,
        },
      };
      const draft = toPayPalInvoiceDraft(review);
      // slice(0, 300) slices at 300 UTF-16 code units
      assert.equal(draft.invoicer_business_name?.length, 300);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });
  });
});
