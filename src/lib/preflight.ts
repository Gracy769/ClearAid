import type { Finding, ReviewInput, ReviewResult, SOWRateCardItem } from "@/lib/types";

function cents(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const amount = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function findMatchingRateCardItem(description: string, rateCard: SOWRateCardItem[]): SOWRateCardItem | null {
  const itemTokens = new Set(normalizeTokens(description));
  if (itemTokens.size === 0) return null;

  let bestMatch: SOWRateCardItem | null = null;
  let bestScore = 0;

  for (const sowItem of rateCard) {
    const sowTokens = normalizeTokens(sowItem.description);
    if (sowTokens.length === 0) continue;

    let overlap = 0;
    for (const t of sowTokens) {
      if (itemTokens.has(t)) overlap++;
    }
    const score = overlap / Math.max(sowTokens.length, itemTokens.size);
    const normDesc = description.toLowerCase().trim();
    const normSow = sowItem.description.toLowerCase().trim();
    const isSubstring = normDesc.includes(normSow) || normSow.includes(normDesc);

    const finalScore = isSubstring ? Math.max(score, 0.7) : score;
    if (finalScore > bestScore && finalScore >= 0.25) {
      bestScore = finalScore;
      bestMatch = sowItem;
    }
  }

  return bestMatch;
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
  for (const key of ["vendorName", "buyerName", "buyerEmail", "poNumber", "currency"] as const) {
    const expected = input.sourceTerms?.[key]?.trim();
    const actual = input[key]?.trim();
    if (expected && actual && expected.toLowerCase() !== actual.toLowerCase()) {
      findings.push({ code: `source_mismatch_${key}`, severity: "block", message: `${key === "poNumber" ? "PO reference" : key === "currency" ? "Currency" : key === "buyerEmail" ? "Buyer email" : key === "vendorName" ? "Vendor identity" : "Buyer identity"} differs from the uploaded PO/SOW.` });
    }
  }
  if (input.items.length > 50) findings.push({ code: "too_many_items", severity: "block", message: "An invoice can contain at most 50 line items." });
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

  // SOW Rate Card Validation (Step 3)
  if (input.sourceTerms?.rateCard && input.sourceTerms.rateCard.length > 0) {
    input.items.forEach((item, index) => {
      const match = findMatchingRateCardItem(item.description, input.sourceTerms!.rateCard!);
      if (!match) {
        findings.push({
          code: `unauthorized_item_${index}`,
          severity: "block",
          message: `Line ${index + 1} ("${item.description}") is not authorized under the campaign SOW rate card.`,
        });
      } else {
        const itemRate = cents(item.unitAmount);
        const sowMaxRate = cents(match.maxUnitRate);
        const qty = Number(item.quantity);

        if (itemRate !== null && sowMaxRate !== null && itemRate > sowMaxRate) {
          const excess = ((itemRate - sowMaxRate) / 100).toFixed(2);
          findings.push({
            code: `rate_exceeds_sow_${index}`,
            severity: "block",
            message: `Line ${index + 1} ("${item.description}") rate $${item.unitAmount} exceeds SOW maximum $${match.maxUnitRate} by $${excess}/unit.`,
          });
        }

        if (match.maxQuantity !== undefined && Number.isSafeInteger(qty) && qty > match.maxQuantity) {
          findings.push({
            code: `quantity_exceeds_sow_${index}`,
            severity: "block",
            message: `Line ${index + 1} ("${item.description}") quantity ${qty} exceeds SOW allocation of ${match.maxQuantity}.`,
          });
        }
      }
    });
  }

  if (!input.evidence?.length) findings.push({ code: "no_source_evidence", severity: "warning", message: "No searchable PO/SOW evidence was found. Confirm the invoice terms manually." });
  return { status: findings.some(f => f.severity === "block") ? "HOLD" : "READY", input, findings, totalMinor };
}
