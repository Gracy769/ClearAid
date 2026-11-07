export type SourceRef = { document: string; page?: number; quote: string };
export type SourceTerms = Partial<{ vendorName: string; buyerName: string; buyerEmail: string; poNumber: string; currency: string }>;
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
};
export type Finding = { code: string; severity: "block" | "warning"; message: string; refs?: SourceRef[] };
export type ReviewResult = { status: "READY" | "HOLD"; input: ReviewInput; findings: Finding[]; totalMinor: number };

export type BatchReportReview = {
  id: string;
  sectionTitle: string;
  approvalToken: string;
  review: ReviewResult;
};
