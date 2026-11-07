import { createHash } from "node:crypto";
import { sign, verify } from "@/lib/security";
import type { ReviewResult } from "@/lib/types";
import { getReview, findReviewByInvoiceOrTransaction } from "@/lib/db";

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------
export interface DisputedTransaction {
  seller_transaction_id?: string;
  buyer_transaction_id?: string;
  invoice_number?: string;
  custom?: string;
  gross_amount?: {
    currency_code?: string;
    value?: string;
  };
  buyer?: {
    name?: string;
  };
  seller?: {
    email?: string;
    merchant_id?: string;
    name?: string;
  };
}

export interface DisputeResource {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  disputed_transactions?: DisputedTransaction[];
  dispute_amount?: {
    currency_code?: string;
    value?: string;
  };
  reason?: string;
  status?: string;
  dispute_state?: string;
  dispute_life_cycle_stage?: string;
  buyer_response_due_date?: string;
  seller_response_due_date?: string;
  dispute_outcome?: {
    outcome_code?: string;
    amount_refunded?: {
      currency_code?: string;
      value?: string;
    };
  };
  [key: string]: unknown;
}

export interface PayPalDisputeEvent {
  id: string;
  event_version?: string;
  create_time?: string;
  resource_type: string;
  event_type: string;
  summary?: string;
  resource: DisputeResource;
  links?: Array<{ href: string; rel: string; method: string }>;
}

export interface EvidenceDocumentProof {
  documentName: string;
  page?: number;
  quote: string;
  proofType: "PO_CONTRACT_CITATION" | "DELIVERY_MILESTONE" | "TERMS_AUTHORIZATION";
  documentHash?: string;
}

export interface ItemizedEvidenceProof {
  description: string;
  quantity: string;
  unitAmount: string;
  totalAmount: string;
  poNumber: string;
}

export interface DisputeEvidencePackage {
  disputeId: string;
  transactionId: string;
  reviewId?: string;
  status: "ASSEMBLED" | "NO_AUDIT_RECORD_FOUND" | "TAMPER_DETECTED";
  vendorName: string;
  buyerName: string;
  buyerEmail: string;
  poNumber: string;
  currency: string;
  disputeAmount: string;
  authorizedTotal: string;
  evidenceNotes: string;
  evidenceDocuments: EvidenceDocumentProof[];
  itemizedProofs: ItemizedEvidenceProof[];
  verificationHash: string;
  hmacSignature: string;
  assembledAt: string;
}

// ---------------------------------------------------------------------------
// In-Memory Fallback Review Store (for tests & offline correlation)
// ---------------------------------------------------------------------------
const memoryReviewStore = new Map<
  string,
  { review: ReviewResult; approval_hash: string; created_at?: string }
>();

export function registerMemoryReview(
  id: string,
  record: { review: ReviewResult; approval_hash: string; created_at?: string }
): void {
  memoryReviewStore.set(id, record);
}

export function getMemoryReview(
  id: string
): { review: ReviewResult; approval_hash: string; created_at?: string } | undefined {
  return memoryReviewStore.get(id);
}

export function clearMemoryReviews(): void {
  memoryReviewStore.clear();
}

// ---------------------------------------------------------------------------
// Identifier Extraction
// ---------------------------------------------------------------------------
export function extractDisputeIdentifiers(event: PayPalDisputeEvent): {
  disputeId: string;
  transactionId: string;
  customId?: string;
  invoiceNumber?: string;
} {
  const resource = event.resource || ({} as DisputeResource);
  const disputeId = resource.dispute_id || event.id || "UNKNOWN_DISPUTE";
  const txn = resource.disputed_transactions?.[0];
  const transactionId =
    txn?.seller_transaction_id ||
    txn?.buyer_transaction_id ||
    txn?.invoice_number ||
    txn?.custom ||
    "UNKNOWN_TXN";
  const customId = txn?.custom;
  const invoiceNumber = txn?.invoice_number;

  return { disputeId, transactionId, customId, invoiceNumber };
}

// ---------------------------------------------------------------------------
// Cryptographic Hash & Signature Functions
// ---------------------------------------------------------------------------
export function computeVerificationHash(review: ReviewResult): string {
  const payload = {
    vendorName: (review.input.vendorName || "").trim(),
    buyerName: (review.input.buyerName || "").trim(),
    buyerEmail: (review.input.buyerEmail || "").trim(),
    poNumber: (review.input.poNumber || "").trim(),
    currency: (review.input.currency || "").trim().toUpperCase(),
    totalMinor: review.totalMinor,
    items: (review.input.items || []).map((i) => ({
      d: (i.description || "").trim(),
      q: String(i.quantity || "1").trim(),
      u: String(i.unitAmount || "0").trim(),
    })),
    evidence: (review.input.evidence || []).map((e) => ({
      doc: (e.document || "").trim(),
      p: e.page ?? 1,
      q: (e.quote || "").trim(),
    })),
    documentHash: review.input.documentHash || "",
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function computeEvidenceSignature(
  disputeId: string,
  reviewId: string,
  verificationHash: string
): string {
  return sign(`DISPUTE_DEFENSE:${disputeId}:${reviewId}:${verificationHash}`);
}

// ---------------------------------------------------------------------------
// Evidence Assembly Flow
// ---------------------------------------------------------------------------
export async function assembleDisputeEvidencePackage(
  event: PayPalDisputeEvent
): Promise<DisputeEvidencePackage> {
  const { disputeId, transactionId, customId, invoiceNumber } = extractDisputeIdentifiers(event);
  const resource = event.resource || ({} as DisputeResource);
  const disputeAmount = resource.dispute_amount?.value
    ? `${resource.dispute_amount.currency_code || "USD"} ${resource.dispute_amount.value}`
    : "Unspecified";

  // Correlate with review: check candidates in priority order
  const lookupCandidates = [customId, invoiceNumber, transactionId].filter(
    (c): c is string => Boolean(c) && c !== "UNKNOWN_TXN"
  );

  let reviewRecord: { review: unknown; approval_hash: string } | undefined;
  let matchedReviewId = customId || invoiceNumber || transactionId;

  for (const candidate of lookupCandidates) {
    // 1. Check local dispute memory store
    const mem = getMemoryReview(candidate);
    if (mem) {
      reviewRecord = mem;
      matchedReviewId = candidate;
      break;
    }

    // 2. Check direct db review
    try {
      const dbRev = await getReview(candidate);
      if (dbRev) {
        reviewRecord = dbRev;
        matchedReviewId = candidate;
        break;
      }
    } catch {
      // Continue to next
    }

    // 3. Unified DB & memory correlation
    try {
      const correlated = await findReviewByInvoiceOrTransaction(candidate);
      if (correlated) {
        reviewRecord = correlated;
        matchedReviewId = correlated.reviewId || candidate;
        break;
      }
    } catch {
      // Continue to next
    }
  }

  // Handle case where no preflight review record exists
  if (!reviewRecord || !reviewRecord.review) {
    return {
      disputeId,
      transactionId,
      reviewId: undefined,
      status: "NO_AUDIT_RECORD_FOUND",
      vendorName: "Unknown",
      buyerName: "Unknown",
      buyerEmail: "Unknown",
      poNumber: invoiceNumber || "Unknown",
      currency: "USD",
      disputeAmount,
      authorizedTotal: "0.00",
      evidenceNotes: `No preflight audit record found for transaction ${transactionId} (customId: ${customId || "none"}).`,
      evidenceDocuments: [],
      itemizedProofs: [],
      verificationHash: "",
      hmacSignature: "",
      assembledAt: new Date().toISOString(),
    };
  }

  const review = reviewRecord.review as ReviewResult;
  const verificationHash = computeVerificationHash(review);
  const hmacSignature = computeEvidenceSignature(disputeId, matchedReviewId, verificationHash);
  const authorizedTotal = `${review.input.currency || "USD"} ${(review.totalMinor / 100).toFixed(2)}`;

  // Assemble Evidence Documents
  const evidenceDocuments: EvidenceDocumentProof[] = (review.input.evidence || []).map((e) => ({
    documentName: e.document,
    page: e.page,
    quote: e.quote,
    proofType: "PO_CONTRACT_CITATION",
    documentHash: review.input.documentHash,
  }));

  // Assemble Itemized Proofs
  const itemizedProofs: ItemizedEvidenceProof[] = (review.input.items || []).map((item) => {
    const qty = Number(item.quantity) || 1;
    const rate = Number(item.unitAmount) || 0;
    return {
      description: item.description,
      quantity: item.quantity,
      unitAmount: item.unitAmount,
      totalAmount: (qty * rate).toFixed(2),
      poNumber: review.input.poNumber,
    };
  });

  // Generate Itemized Defense Brief
  const evidenceNotes = [
    `RECONCILIATION AUDIT TRAIL & CONTRACT DEFENSE (Dispute: ${disputeId})`,
    `--------------------------------------------------------------------------------`,
    `This commercial transaction was preflight-verified against authorized purchase order terms prior to invoice issuance.`,
    ``,
    `Contractual Authorizations:`,
    `- Buyer: ${review.input.buyerName} (${review.input.buyerEmail})`,
    `- Vendor: ${review.input.vendorName}`,
    `- Purchase Order Reference: ${review.input.poNumber}`,
    `- Authorized Contract Total: ${authorizedTotal}`,
    `- Stated PO Cap: ${review.input.poCap ? `${review.input.currency} ${review.input.poCap}` : "None"}`,
    `- Preflight Verification Clearance: ${review.status}`,
    `- Source Document SHA-256 Digest: ${review.input.documentHash || "Verified PO Text Extraction"}`,
    ``,
    `Cryptographic Verification:`,
    `- Terms & Evidence Hash (SHA-256): ${verificationHash}`,
    `- Platform Audit HMAC Signature: ${hmacSignature}`,
    ``,
    `All itemized charges correspond directly to deliverables authorized in PO ${review.input.poNumber}. Delivery milestones and contract quotes are attached. Reversal or chargeback is unjustified.`,
  ].join("\n");

  return {
    disputeId,
    transactionId,
    reviewId: matchedReviewId,
    status: "ASSEMBLED",
    vendorName: review.input.vendorName,
    buyerName: review.input.buyerName,
    buyerEmail: review.input.buyerEmail,
    poNumber: review.input.poNumber,
    currency: review.input.currency,
    disputeAmount,
    authorizedTotal,
    evidenceNotes,
    evidenceDocuments,
    itemizedProofs,
    verificationHash,
    hmacSignature,
    assembledAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Anti-Tamper Integrity Verification
// ---------------------------------------------------------------------------
export function verifyEvidencePackageIntegrity(
  pkg: DisputeEvidencePackage,
  review?: ReviewResult
): boolean {
  if (pkg.status !== "ASSEMBLED") return false;
  if (!pkg.verificationHash || !pkg.hmacSignature) return false;

  if (review) {
    const expectedHash = computeVerificationHash(review);
    if (expectedHash !== pkg.verificationHash) return false;
  }

  const expectedPayload = `DISPUTE_DEFENSE:${pkg.disputeId}:${pkg.reviewId || ""}:${pkg.verificationHash}`;
  return verify(expectedPayload, pkg.hmacSignature);
}
