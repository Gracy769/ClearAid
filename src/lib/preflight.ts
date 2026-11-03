import type { Finding, ReviewInput, ReviewResult } from "@/lib/types";

function cents(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const amount = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

export function runPreflight(input: ReviewInput): ReviewResult {
  const findings: Finding[] = [];
  const required: [keyof ReviewInput, string][] = [
    ["vendorName", "Vendor name"], ["buyerName", "Buyer name"],
    ["buyerEmail", "Buyer email"], ["poNumber", "PO number"], ["currency", "Currency"],
  ];
  for (const [key, label] of required) {
    if (!String(input[key] ?? "").trim()) findings.push({ code: `missing_${key}`, severity: "block", message: `${label} is required.` });
  }
  if (input.buyerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.buyerEmail)) {
    findings.push({ code: "invalid_buyer_email", severity: "block", message: "Enter a valid buyer email." });
  }
  if (input.currency && !/^[A-Z]{3}$/.test(input.currency)) {
    findings.push({ code: "invalid_currency", severity: "block", message: "Use a three-letter ISO currency code." });
  }
  if (!input.items.length) findings.push({ code: "no_items", severity: "block", message: "Add at least one invoice line item." });
  let totalMinor = 0;
  input.items.forEach((item, index) => {
    const qty = Number(item.quantity);
    const rate = cents(item.unitAmount);
    if (!item.description.trim()) findings.push({ code: `item_${index}_description`, severity: "block", message: `Line ${index + 1}: description is required.` });
    if (!Number.isSafeInteger(qty) || qty <= 0) findings.push({ code: `item_${index}_quantity`, severity: "block", message: `Line ${index + 1}: quantity must be a positive whole number.` });
    if (rate === null) findings.push({ code: `item_${index}_rate`, severity: "block", message: `Line ${index + 1}: rate must be a positive amount with up to two decimals.` });
    if (rate !== null && Number.isSafeInteger(qty) && qty > 0) totalMinor += rate * qty;
  });
  if (!Number.isSafeInteger(totalMinor)) findings.push({ code: "total_overflow", severity: "block", message: "Invoice total exceeds the supported amount." });
  if (input.poCap) {
    const cap = cents(input.poCap);
    if (cap === null) findings.push({ code: "invalid_po_cap", severity: "block", message: "PO cap must be a positive amount." });
    else if (totalMinor > cap) findings.push({ code: "po_cap_exceeded", severity: "block", message: "Invoice total exceeds the stated PO cap." });
  }
  if (!input.sourceText?.trim()) findings.push({ code: "no_source_evidence", severity: "warning", message: "No PO/SOW text was attached. Confirm the invoice terms manually." });
  return { status: findings.some(f => f.severity === "block") ? "HOLD" : "READY", input, findings, totalMinor };
}
