export type SourceRef = { document: string; page?: number; quote: string };

export type SOWRateCardItem = {
  description: string;
  maxUnitRate: string;
  maxQuantity?: number;
  category?: string;
};

export type SourceTerms = Partial<{
  vendorName: string;
  buyerName: string;
  buyerEmail: string;
  poNumber: string;
  currency: string;
  rateCard: SOWRateCardItem[];
  sowHash?: string;
}>;
export type LineItem = { description: string; quantity: string; unitAmount: string; sourceRefs?: SourceRef[] };
export type ReviewInput = {
  vendorName: string;
  buyerName: string;
  buyerEmail: string;
  poNumber: string;
  currency: string;
  poCap?: string;
  items: LineItem[];
  evidence?: SourceRef[];
  documentHash?: string;
  sourceTerms?: SourceTerms;
  campaignId?: string;
};
export type Finding = { code: string; severity: "block" | "warning"; message: string; refs?: SourceRef[] };
export type ReviewResult = {
  status: "READY" | "HOLD";
  input: ReviewInput;
  findings: Finding[];
  totalMinor: number;
  agentResult?: {
    status?: string;
    discrepancies?: unknown[];
    steps?: unknown[];
    summary?: string;
  };
};

export type BatchReportReview = {
  id: string;
  sectionTitle: string;
  approvalToken: string;
  review: ReviewResult;
};

export type ReliefCampaign = {
  id: string;
  title: string;
  subtitle: string;
  category: "Medical" | "Water & Sanitation" | "Shelter & Power" | "Food Logistics" | "Emergency Aid";
  targetMinor: number;
  raisedMinor: number;
  disbursedMinor: number;
  availableMinor?: number;
  currency: string;
  grantCode: string;
  leadAgency: string;
  disasterZone: string;
  urgent?: boolean;
  sowRateCard?: SOWRateCardItem[];
  sowHash?: string;
};

export type Vendor = {
  id: string;
  name: string;
  payoutEmail: string;
  status: "ACTIVE" | "SUSPENDED";
  registeredBy?: string;
  createdAt?: string;
};

export type Disbursement = {
  id: string;
  campaignId: string;
  vendorId: string;
  vendorName?: string;
  payoutEmail?: string;
  reviewId: string;
  amountMinor: number;
  currency: string;
  status: "APPROVED" | "PAYOUT_SUBMITTED" | "PAID" | "FAILED" | "APPROVED_PENDING_PAYOUT";
  payoutBatchId?: string;
  payoutItemId?: string;
  proofHash: string;
  createdAt?: string;
  updatedAt?: string;
};

export type LedgerEntry = {
  id: number;
  kind: "DONATION_COMPLETED" | "DISBURSEMENT_APPROVED" | "PAYOUT_PAID" | "PAYOUT_FAILED";
  refId: string;
  campaignId?: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  prevHash: string;
  entryHash: string;
  createdAt: string;
};

export type PublicDisbursementRecord = {
  id: string;
  campaignId: string;
  campaignTitle: string;
  paypalInvoiceId: string;
  vendorName: string;
  buyerName?: string;
  grantCode?: string;
  category: string;
  amountMinor: number;
  currency: string;
  preflightProofHash: string;
  timestamp: string;
  hostedInvoiceUrl?: string;
  status: "VERIFIED_DRAFT" | "PAID_VIA_PAYPAL" | "APPROVED" | "PAYOUT_SUBMITTED" | "PAID" | "FAILED";
  isSimulated?: boolean;
  items?: Array<{ description: string; quantity: string; unitAmount: string }>;
};
