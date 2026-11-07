import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import {
  formatUnitAmount,
  paypalCreateInvoiceSchema,
  toPayPalInvoiceDraft,
} from "../src/lib/paypal-adapter";
import type { ReviewResult } from "../src/lib/types";

// Offline instance of PayPalAgentToolkit to test live parameter schema parser
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
  totalMinor: 75150,
  findings: [],
  input: {
    vendorName: "Northstar Studio",
    buyerName: "Acme Corp",
    buyerEmail: "ap@example.com",
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
  },
};

describe("PayPal Invoice Adapter Suite", () => {
  describe("1. Canonical Transformation & Schema Dual-Validation", () => {
    it("transforms canonical review into flat schema matching both local and toolkit schemas", () => {
      const draft = toPayPalInvoiceDraft(baseValidReview);

      // Verify top-level flat properties
      assert.equal(draft.currency_code, "USD");
      assert.equal(draft.reference, "PO-1042");
      assert.equal(draft.note, "PO PO-1042 verified by Preflight Engine");
      assert.equal(draft.invoicer_business_name, "Northstar Studio");
      assert.equal(draft.invoicer_given_name, "Northstar Studio");
      assert.equal(draft.allow_partial_payment, false);

      // Verify recipients
      assert.equal(draft.primary_recipients.length, 1);
      assert.equal(draft.primary_recipients[0].billing_info?.business_name, "Acme Corp");
      assert.equal(draft.primary_recipients[0].billing_info?.name?.given_name, "Acme Corp");
      assert.equal(draft.primary_recipients[0].billing_info?.email_address, "ap@example.com");

      // Verify items
      assert.equal(draft.items.length, 1);
      assert.equal(draft.items[0].name, "Design services");
      assert.equal(draft.items[0].quantity, "3");
      assert.equal(draft.items[0].unit_amount.currency_code, "USD");
      assert.equal(draft.items[0].unit_amount.value, "250.50");

      // Dual-validation against local and live toolkit parsers
      const localResult = paypalCreateInvoiceSchema.safeParse(draft);
      assert.equal(localResult.success, true, "Must satisfy local paypalCreateInvoiceSchema");

      const tkResult = toolkitSchema.safeParse(draft);
      assert.equal(tkResult.success, true, "Must satisfy live @paypal/agent-toolkit parameters");
    });

    it("transforms multi-item reviews preserving item sequence and amounts", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          items: [
            { description: "Item 1", quantity: "1", unitAmount: "10.00" },
            { description: "Item 2", quantity: "5", unitAmount: "20.00" },
            { description: "Item 3", quantity: "2", unitAmount: "100.50" },
          ],
        },
      };

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items.length, 3);
      assert.equal(draft.items[1].quantity, "5");
      assert.equal(draft.items[1].unit_amount.value, "20.00");
      assert.equal(draft.items[2].unit_amount.value, "100.50");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });
  });

  describe("2. Boundary Cases: Buyer and Vendor Names", () => {
    it("handles missing buyerName without emitting empty strings", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, buyerName: "" },
      };

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.primary_recipients[0].billing_info?.business_name, undefined);
      assert.equal(draft.primary_recipients[0].billing_info?.name, undefined);
      assert.equal(draft.primary_recipients[0].billing_info?.email_address, "ap@example.com");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("handles whitespace-only buyerName safely", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, buyerName: "   " },
      };

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.primary_recipients[0].billing_info?.business_name, undefined);
      assert.equal(draft.primary_recipients[0].billing_info?.name, undefined);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("truncates buyerName exceeding 300 characters for business_name and 140 for given_name", () => {
      const longName = "A".repeat(350);
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, buyerName: longName },
      };

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.primary_recipients[0].billing_info?.business_name?.length, 300);
      assert.equal(draft.primary_recipients[0].billing_info?.name?.given_name?.length, 140);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("handles missing vendorName without emitting empty strings", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, vendorName: "" },
      };

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.invoicer_business_name, undefined);
      assert.equal(draft.invoicer_given_name, undefined);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("truncates vendorName exceeding 300 characters", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, vendorName: "V".repeat(320) },
      };

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.invoicer_business_name?.length, 300);
      assert.equal(draft.invoicer_given_name?.length, 140);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });
  });

  describe("3. Boundary Cases: Line Items, Rates, and Quantities", () => {
    it("normalizes unformatted rates to exact 2-decimal format", () => {
      assert.equal(formatUnitAmount("250.5"), "250.50");
      assert.equal(formatUnitAmount("10"), "10.00");
      assert.equal(formatUnitAmount("0"), "0.00");
      assert.equal(formatUnitAmount("99.99"), "99.99");

      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          items: [{ description: "Dev", quantity: "1", unitAmount: "250.5" }],
        },
      };

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items[0].unit_amount.value, "250.50");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("handles zero unit amount items (promotional / sample items)", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          items: [{ description: "Free Tier", quantity: "1", unitAmount: "0.00" }],
        },
      };

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items[0].unit_amount.value, "0.00");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("falls back to 'Item N' when description is blank or whitespace", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          items: [
            { description: "", quantity: "1", unitAmount: "10.00" },
            { description: "   ", quantity: "2", unitAmount: "20.00" },
          ],
        },
      };

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items[0].name, "Item 1");
      assert.equal(draft.items[0].description, undefined);
      assert.equal(draft.items[1].name, "Item 2");
      assert.equal(draft.items[1].description, undefined);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("truncates item names exceeding 300 characters while preserving full description", () => {
      const longDesc = "D".repeat(400);
      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          items: [{ description: longDesc, quantity: "1", unitAmount: "10.00" }],
        },
      };

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items[0].name.length, 300);
      assert.equal(draft.items[0].description, longDesc);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("defaults empty quantity to '1'", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: {
          ...baseValidReview.input,
          items: [{ description: "Consulting", quantity: "", unitAmount: "50.00" }],
        },
      };

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.items[0].quantity, "1");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });
  });

  describe("4. Boundary Cases: Currencies", () => {
    it("normalizes lowercase currencies to uppercase across root and all items", () => {
      const review: ReviewResult = {
        ...baseValidReview,
        input: { ...baseValidReview.input, currency: "eur" },
      };

      const draft = toPayPalInvoiceDraft(review);
      assert.equal(draft.currency_code, "EUR");
      assert.equal(draft.items[0].unit_amount.currency_code, "EUR");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("supports GBP, CAD, AUD, and JPY currencies", () => {
      for (const curr of ["GBP", "CAD", "AUD", "JPY"]) {
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

    it("rejects invalid currency codes (length != 3, symbols, numbers)", () => {
      const invalidCodes = ["US", "USDT", "123", "$$$", ""];
      for (const code of invalidCodes) {
        const review: ReviewResult = {
          ...baseValidReview,
          input: { ...baseValidReview.input, currency: code },
        };
        assert.throws(
          () => toPayPalInvoiceDraft(review),
          /Invalid currency code/,
          `Should reject invalid currency: ${code}`
        );
      }
    });
  });

  describe("5. Invariants and Guardrail Rejections", () => {
    it("throws when review status is 'HOLD'", () => {
      assert.throws(
        () => toPayPalInvoiceDraft({ ...baseValidReview, status: "HOLD" }),
        /Cannot adapt review with status 'HOLD'/
      );
    });

    it("throws when review input has no line items", () => {
      assert.throws(
        () =>
          toPayPalInvoiceDraft({
            ...baseValidReview,
            input: { ...baseValidReview.input, items: [] },
          }),
        /Cannot adapt review without line items/
      );
    });

    it("throws when review is undefined or null", () => {
      assert.throws(
        () => toPayPalInvoiceDraft(undefined as unknown as ReviewResult),
        /Cannot adapt review with status 'undefined'/
      );
    });
  });

  describe("6. Adapter Options and Customization", () => {
    it("supports custom notes", () => {
      const draft = toPayPalInvoiceDraft(baseValidReview, {
        note: "Custom Payment Terms: Net 30",
      });
      assert.equal(draft.note, "Custom Payment Terms: Net 30");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("supports valid invoice_date (YYYY-MM-DD)", () => {
      const draft = toPayPalInvoiceDraft(baseValidReview, {
        invoiceDate: "2026-11-07",
      });
      assert.equal(draft.invoice_date, "2026-11-07");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("fails when invoiceDate does not conform to YYYY-MM-DD", () => {
      assert.throws(() => {
        toPayPalInvoiceDraft(baseValidReview, {
          invoiceDate: "11/07/2026",
        });
      }, /invoice_date/);
    });

    it("supports allowPartialPayment flag", () => {
      const draft = toPayPalInvoiceDraft(baseValidReview, {
        allowPartialPayment: true,
      });
      assert.equal(draft.allow_partial_payment, true);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("supports valid themeColor hex string", () => {
      const draft = toPayPalInvoiceDraft(baseValidReview, {
        themeColor: "#0070BA",
      });
      assert.equal(draft.theme_color, "#0070BA");
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });

    it("fails when themeColor is not a valid hex string", () => {
      assert.throws(() => {
        toPayPalInvoiceDraft(baseValidReview, {
          themeColor: "blue",
        });
      }, /theme_color/);
    });

    it("supports shippingCost and enablePayByBank options", () => {
      const draft = toPayPalInvoiceDraft(baseValidReview, {
        shippingCost: "15.00",
        enablePayByBank: true,
      });
      assert.equal(draft.shipping_cost, "15.00");
      assert.equal(draft.enable_pay_by_bank, true);
      assert.equal(toolkitSchema.safeParse(draft).success, true);
    });
  });
});
