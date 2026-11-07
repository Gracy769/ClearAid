import type { ReviewInput } from "@/lib/types";

function money(value: string) {
  return value.replace(/,/g, "").trim();
}

export function extractTermsFromPdfText(text: string): Partial<ReviewInput> {
  const result: Partial<ReviewInput> = {};

  // 1. PO Number
  const poMatch =
    text.match(/(?:\bPurchase\s+Order\s*(?:Number|No|#)?|\bPO\b\s*(?:Number|No|#)?)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-_/]+)/i) ||
    text.match(/\b(PO[-\s][A-Z0-9][A-Z0-9-]*)\b/i);
  if (poMatch) result.poNumber = poMatch[1].replace(/\s+/g, "-");

  // 2. Currency
  const currMatch = text.match(/\b(USD|EUR|GBP|CAD|AUD|INR)\b/i);
  if (currMatch) result.currency = currMatch[1].toUpperCase();

  // 3. PO Cap / Maximum
  const capMatch =
    text.match(/(?:PO\s*(?:Maximum|Cap|Limit)|spend\s+ceiling|budget\s+cap|maximum\s+cap|not\s+(?:to\s+)?exceed(?:\s+a\s+total)?)\s*(?:of|:)?\s*\$?([\d,]+(?:\.\d{1,2})?)/i) ||
    text.match(/\bPO\s+MAXIMUM\s+\$?([\d,]+(?:\.\d{1,2})?)/i);
  if (capMatch) result.poCap = money(capMatch[1]);

  // 4. Classic BUYER VENDOR block compatibility
  const classicMatch = text.match(/\bBUYER\s+VENDOR\b([\s\S]*?)\bAUTHORIZED WORK\b/i)?.[1];
  if (classicMatch) {
    const parties = classicMatch.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const attn = parties.flatMap((line, index) => /^Attn\s*:/i.test(line) ? [index] : []);
    if (attn.length >= 2) {
      result.buyerName = parties[attn[0] - 1] || "";
      result.vendorName = parties[attn[1] - 1] || "";
    }
    const email = parties.find((line) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line));
    if (email) result.buyerEmail = email;
  }

  // Generalized Buyer extraction
  if (!result.buyerName) {
    const buyerMatch =
      text.match(/(?:BUYER(?:\s*\/\s*PRINCIPAL)?|BILL\s+TO|CLIENT|CUSTOMER)\s*:\s*\r?\n*([^\r\n]+)/i) ||
      text.match(/([^\r\n]+?)\s*\((?:Buyer|Client)\)/i);
    if (buyerMatch) {
      result.buyerName = buyerMatch[1].trim().replace(/^[:\-\s]+/, "");
    }
  }

  // Generalized Vendor extraction
  if (!result.vendorName) {
    const vendorMatch =
      text.match(/(?:VENDOR(?:\s*\/\s*SERVICE\s+PROVIDER)?|SERVICE\s+PROVIDER|CONTRACTOR|REMIT\s+TO)\s*:\s*\r?\n*([^\r\n]+)/i) ||
      text.match(/([^\r\n]+?)\s*\((?:Vendor|Service Provider)\)/i);
    if (vendorMatch) {
      result.vendorName = vendorMatch[1].trim().replace(/^[:\-\s]+/, "");
    }
  }

  // Generalized Email extraction
  if (!result.buyerEmail) {
    const emailExplicit = text.match(/(?:Authorized\s+Recipient\s+Email|Recipient\s+Email|Buyer\s+Email|AP\s+Email|Accounts\s+Payable|Billing\s+Email|AP\s+Contact)\s*:\s*\r?\n*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    if (emailExplicit) {
      result.buyerEmail = emailExplicit[1].trim();
    } else {
      const emails = [...text.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)].map((m) => m[0]);
      const buyerCandidate = emails.find((e) => /buyer|ap|procure|account|payable|invoice/i.test(e));
      if (buyerCandidate) {
        result.buyerEmail = buyerCandidate;
      } else if (emails.length > 0) {
        result.buyerEmail = emails[0];
      }
    }
  }

  // 5. Line items extraction
  // Multi-line table item parser for numbered deliverables
  const numberedItemRegex = /(\d+)\.\s+([\s\S]*?)\s+(\d+(?:\.\d+)?)\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})/g;
  const itemBlocks: Array<{ description: string; quantity: string; unitAmount: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = numberedItemRegex.exec(text)) !== null) {
    const desc = match[2].replace(/\s+/g, " ").trim();
    const cleanDesc = desc.split(/\s+(?:[A-Z]\.\s+[A-Z]|[A-Z][a-z]+\s+\(Lead|Security Audit Team)/)[0].trim() || desc;
    itemBlocks.push({
      description: cleanDesc,
      quantity: match[3],
      unitAmount: money(match[4]),
    });
  }

  if (itemBlocks.length > 0) {
    result.items = itemBlocks;
  } else {
    // Single-line fallback
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const items = lines.flatMap((line) => {
      const singleMatch = line.match(/^(.+?)\s+(\d+)\s+\$([\d,]+\.\d{2})(?:\s+\$[\d,]+\.\d{2})?$/);
      if (!singleMatch || /^(TOTAL|PO MAXIMUM)\b/i.test(singleMatch[1])) return [];
      return [{ description: singleMatch[1].trim(), quantity: singleMatch[2], unitAmount: money(singleMatch[3]) }];
    });
    if (items.length) result.items = items;
  }

  return result;
}

export interface ExtractedReportSegment {
  title: string;
  terms: Partial<ReviewInput>;
}

export interface MultiReportExtraction {
  isMulti: boolean;
  reports: ExtractedReportSegment[];
}

export function extractMultiReportsFromPdfText(text: string): MultiReportExtraction {
  const globalTerms = extractTermsFromPdfText(text);

  // Match report, schedule, tranche, or work order boundaries
  const segmentHeaderRegex = /(?:^|\r?\n)(?:(?:REPORT|SCHEDULE|WORK ORDER|TRANCHE|MILESTONE)\s+(?:[0-9]+|[A-Z])\b[^\r\n]*)/gi;
  const matches = [...text.matchAll(segmentHeaderRegex)];

  if (matches.length < 2) {
    return {
      isMulti: false,
      reports: [{ title: "Primary Statement of Work", terms: globalTerms }],
    };
  }

  const reports: ExtractedReportSegment[] = [];
  for (let i = 0; i < matches.length; i++) {
    const startIdx = matches[i].index ?? 0;
    const endIdx = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const segmentText = text.slice(startIdx, endIdx);
    const headerTitle = matches[i][0].replace(/^\r?\n/, "").trim();

    // Extract terms specific to this segment
    const localTerms = extractTermsFromPdfText(segmentText);

    // Merge: prioritize local, fallback to global document terms
    const mergedTerms: Partial<ReviewInput> = {
      vendorName: localTerms.vendorName || globalTerms.vendorName || "",
      buyerName: localTerms.buyerName || globalTerms.buyerName || "",
      buyerEmail: localTerms.buyerEmail || globalTerms.buyerEmail || "",
      poNumber: localTerms.poNumber || (globalTerms.poNumber ? `${globalTerms.poNumber}-${i + 1}` : `PO-REPORT-${i + 1}`),
      currency: localTerms.currency || globalTerms.currency || "USD",
      poCap: localTerms.poCap || "",
      items: localTerms.items && localTerms.items.length > 0 ? localTerms.items : [],
    };

    reports.push({
      title: headerTitle,
      terms: mergedTerms,
    });
  }

  return {
    isMulti: true,
    reports,
  };
}
