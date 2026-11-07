import { z } from "zod";
import type { ReviewResult } from "@/lib/types";

// ============================================================================
// Standard Regex Constraints (matching @paypal/agent-toolkit specifications)
// ============================================================================
export const DECIMAL_STRING_REGEX = /^((-?[0-9]+)|(-?([0-9]+)?[.][0-9]+))$/;
export const DATE_NO_TIME_REGEX = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])$/;
export const COUNTRY_CODE_REGEX = /^([A-Z]{2}|C2)$/;
export const HEX_COLOR_REGEX = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
export const LANGUAGE_REGEX = /^[a-z]{2}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;
export const ISO_CURRENCY_REGEX = /^[A-Z]{3}$/;

// ============================================================================
// Sub-Schemas
// ============================================================================

export const moneySchema = z.object({
  currency_code: z.string().length(3).describe("The three-character ISO-4217 currency code."),
  value: z.string().regex(DECIMAL_STRING_REGEX, 'value must be a numeric value, e.g. "50.00"'),
});

export const personNameSchema = z.object({
  given_name: z.string().max(140).optional().describe("The first name of the person."),
  surname: z.string().max(140).optional().describe("The last name of the person."),
});

export const addressSchema = z.object({
  address_line_1: z.string().optional(),
  address_line_2: z.string().optional(),
  admin_area_2: z.string().optional().describe("City, town, or village."),
  admin_area_1: z.string().optional().describe("State or province."),
  postal_code: z.string().optional(),
  country_code: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().regex(COUNTRY_CODE_REGEX, "country_code must be a two-character ISO 3166-1 country code").optional()
  ),
});

export const phoneSchema = z.object({
  country_code: z.string().describe("Country calling code in E.164 format (e.g. '1')."),
  national_number: z.string().describe("National number in E.164 format."),
  phone_type: z.enum(["FAX", "HOME", "MOBILE", "OTHER", "PAGER"]),
});

export const invoiceTaxSchema = z.object({
  name: z.string().describe("Name of the tax applied, e.g. Sales Tax."),
  percent: z.string().regex(DECIMAL_STRING_REGEX, 'percent must be a numeric value, e.g. "18"'),
  tax_note: z.string().optional(),
});

export const invoiceDiscountSchema = z
  .object({
    percent: z.string().regex(DECIMAL_STRING_REGEX).optional(),
    amount: moneySchema.optional(),
  })
  .refine(
    (val) => val.percent === undefined || val.amount === undefined,
    { message: "percent and amount cannot both be set on the same discount -- use only one.", path: ["amount"] }
  );

export const invoiceItemSchema = z.object({
  name: z.string().min(1, "Item name cannot be empty"),
  description: z.string().optional(),
  quantity: z.string().regex(DECIMAL_STRING_REGEX, "Quantity must be numeric"),
  unit_amount: moneySchema,
  tax: invoiceTaxSchema.optional(),
  discount: invoiceDiscountSchema.optional(),
  item_date: z.string().regex(DATE_NO_TIME_REGEX, "item_date must be in yyyy-MM-DD format").optional(),
  unit_of_measure: z.enum(["QUANTITY", "HOURS", "AMOUNT"]).optional(),
});

export const billingInfoSchema = z.object({
  business_name: z.string().max(300).optional(),
  name: personNameSchema.optional(),
  address: addressSchema.optional(),
  email_address: z.string().optional(),
  phones: z.array(phoneSchema).optional(),
  additional_info: z.string().max(40).optional(),
  language: z.string().regex(LANGUAGE_REGEX, "language must be a BCP-47 tag, e.g. en-US").optional(),
});

export const shippingInfoSchema = z.object({
  business_name: z.string().optional(),
  name: personNameSchema.optional(),
  address: addressSchema.optional(),
});

export const recipientSchema = z.object({
  billing_info: billingInfoSchema.optional(),
  shipping_info: shippingInfoSchema.optional(),
});

// ============================================================================
// Main Create Invoice Parameter Schema
// ============================================================================

export const paypalCreateInvoiceSchema = z.object({
  currency_code: z.string().length(3).regex(ISO_CURRENCY_REGEX, "Must be a 3-letter ISO-4217 currency code"),
  invoice_number: z.string().optional(),
  invoice_date: z.string().regex(DATE_NO_TIME_REGEX, "invoice_date must be in yyyy-MM-DD format").optional(),
  reference: z.string().optional(),
  note: z.string().optional(),
  invoicer_business_name: z.string().max(300).optional(),
  invoicer_given_name: z.string().max(140).optional(),
  invoicer_surname: z.string().max(140).optional(),
  invoicer_email_address: z.string().optional(),
  invoicer_tax_id: z.string().optional(),
  invoicer_address_line_1: z.string().optional(),
  invoicer_address_line_2: z.string().optional(),
  invoicer_city: z.string().optional(),
  invoicer_state: z.string().optional(),
  invoicer_postal_code: z.string().optional(),
  invoicer_country_code: z.string().regex(COUNTRY_CODE_REGEX, "Must be a 2-character ISO 3166-1 country code").optional(),
  primary_recipients: z.array(recipientSchema).min(1, "Invoice must include at least one recipient."),
  items: z.array(invoiceItemSchema).min(1, "Invoice must include at least one item."),
  allow_tip: z.boolean().optional(),
  theme_color: z.string().regex(HEX_COLOR_REGEX, "theme_color must be a hex color, e.g. #003087").optional(),
  shipping_cost: z.string().regex(DECIMAL_STRING_REGEX).optional(),
  enable_pay_by_bank: z.boolean().optional(),
  pay_by_bank_exclusive_above_threshold: z.boolean().optional(),
  allow_partial_payment: z.boolean().optional(),
  minimum_partial_payment_amount: z.string().regex(DECIMAL_STRING_REGEX).optional(),
});

// ============================================================================
// Inferred TypeScript Types
// ============================================================================

export type Money = z.infer<typeof moneySchema>;
export type PersonName = z.infer<typeof personNameSchema>;
export type Address = z.infer<typeof addressSchema>;
export type Phone = z.infer<typeof phoneSchema>;
export type InvoiceTax = z.infer<typeof invoiceTaxSchema>;
export type InvoiceDiscount = z.infer<typeof invoiceDiscountSchema>;
export type InvoiceItem = z.infer<typeof invoiceItemSchema>;
export type BillingInfo = z.infer<typeof billingInfoSchema>;
export type ShippingInfo = z.infer<typeof shippingInfoSchema>;
export type InvoiceRecipient = z.infer<typeof recipientSchema>;
export type PayPalCreateInvoiceInput = z.infer<typeof paypalCreateInvoiceSchema>;

// ============================================================================
// Adapter Options & Pure Transformer
// ============================================================================

export interface AdapterOptions {
  note?: string;
  invoiceDate?: string;
  allowPartialPayment?: boolean;
  themeColor?: string;
  shippingCost?: string;
  enablePayByBank?: boolean;
}

/**
 * Normalizes monetary unit rate amounts into a standard 2-decimal string format (e.g. "250.5" -> "250.50").
 */
export function formatUnitAmount(value: string | number): string {
  const trimmed = String(value ?? "").trim();
  if (/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return Number(trimmed).toFixed(2);
  }
  return trimmed;
}

/**
 * Transforms an internal ReviewResult model into the flat schema expected
 * by @paypal/agent-toolkit's create_invoice tool.
 */
export function toPayPalInvoiceDraft(
  review: ReviewResult,
  options?: AdapterOptions
): PayPalCreateInvoiceInput {
  if (!review || review.status !== "READY") {
    throw new Error(`Cannot adapt review with status '${review?.status}' into a PayPal invoice draft.`);
  }

  const { input } = review;
  if (!input || !Array.isArray(input.items) || input.items.length === 0) {
    throw new Error("Cannot adapt review without line items into a PayPal invoice draft.");
  }

  const currencyCode = (input.currency || "").trim().toUpperCase();
  if (!ISO_CURRENCY_REGEX.test(currencyCode)) {
    throw new Error(`Invalid currency code: '${input.currency}'. Expected a 3-letter ISO-4217 code (e.g. USD).`);
  }

  const buyerName = (input.buyerName || "").trim();
  const buyerEmail = (input.buyerEmail || "").trim();
  const vendorName = (input.vendorName || "").trim();
  const poNumber = (input.poNumber || "").trim();

  const billingInfo: Record<string, unknown> = {};
  if (buyerName) {
    billingInfo.business_name = buyerName.slice(0, 300);
    billingInfo.name = { given_name: buyerName.slice(0, 140) };
  }
  if (buyerEmail) {
    billingInfo.email_address = buyerEmail;
  }

  const draft: PayPalCreateInvoiceInput = {
    currency_code: currencyCode,
    reference: poNumber || undefined,
    note: options?.note ?? (poNumber ? `PO ${poNumber} verified by Preflight Engine` : undefined),
    invoicer_business_name: vendorName ? vendorName.slice(0, 300) : undefined,
    invoicer_given_name: vendorName ? vendorName.slice(0, 140) : undefined,
    primary_recipients: [
      {
        billing_info: Object.keys(billingInfo).length > 0 ? billingInfo : undefined,
      },
    ],
    items: input.items.map((item, index) => {
      const desc = (item.description || "").trim();
      const qty = String(item.quantity ?? "1").trim();
      return {
        name: desc.length > 0 ? desc.slice(0, 300) : `Item ${index + 1}`,
        description: desc.length > 0 ? desc : undefined,
        quantity: qty.length > 0 ? qty : "1",
        unit_amount: {
          currency_code: currencyCode,
          value: formatUnitAmount(item.unitAmount),
        },
      };
    }),
    allow_partial_payment: options?.allowPartialPayment ?? false,
  };

  if (options?.invoiceDate) {
    draft.invoice_date = options.invoiceDate;
  }
  if (options?.themeColor) {
    draft.theme_color = options.themeColor;
  }
  if (options?.shippingCost) {
    draft.shipping_cost = options.shippingCost;
  }
  if (options?.enablePayByBank !== undefined) {
    draft.enable_pay_by_bank = options.enablePayByBank;
  }

  // Self-validate prior to return
  return paypalCreateInvoiceSchema.parse(draft);
}
