import type { ReviewInput } from "@/lib/types";

function money(value: string) {
  return value.replace(/,/g, "").trim();
}

export function extractTermsFromPdfText(text: string): Partial<ReviewInput> {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const result: Partial<ReviewInput> = {};

  const po = text.match(/\b(PO[-\s][A-Z0-9][A-Z0-9-]*)\b/i);
  if (po) result.poNumber = po[1].replace(/\s+/g, "-");

  const currency = text.match(/\b(USD|EUR|GBP|CAD|AUD|INR)\b/i);
  if (currency) result.currency = currency[1].toUpperCase();

  const cap = text.match(/\bPO\s+MAXIMUM\s+\$?([\d,]+(?:\.\d{1,2})?)/i);
  if (cap) result.poCap = money(cap[1]);

  const buyerVendor = text.match(/\bBUYER\s+VENDOR\b([\s\S]*?)\bAUTHORIZED WORK\b/i)?.[1];
  if (buyerVendor) {
    const parties = buyerVendor.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const attn = parties.flatMap((line, index) => /^Attn\s*:/i.test(line) ? [index] : []);
    if (attn.length >= 2) {
      result.buyerName = parties[attn[0] - 1] || "";
      result.vendorName = parties[attn[1] - 1] || "";
    }
    const email = parties.find((line) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line));
    if (email) result.buyerEmail = email;
  }

  const items = lines.flatMap((line) => {
    const match = line.match(/^(.+?)\s+(\d+)\s+\$([\d,]+\.\d{2})(?:\s+\$[\d,]+\.\d{2})?$/);
    if (!match || /^(TOTAL|PO MAXIMUM)\b/i.test(match[1])) return [];
    return [{ description: match[1].trim(), quantity: match[2], unitAmount: money(match[3]) }];
  });
  if (items.length) result.items = items;
  return result;
}
