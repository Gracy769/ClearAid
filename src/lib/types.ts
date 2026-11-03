export type SourceRef = { document: string; page?: number; quote: string };
export type LineItem = { description: string; quantity: string; unitAmount: string; sourceRefs?: SourceRef[] };
export type ReviewInput = {
  vendorName: string;
  buyerName: string;
  buyerEmail: string;
  poNumber: string;
  currency: string;
  poCap?: string;
  items: LineItem[];
  sourceText?: string;
};
export type Finding = { code: string; severity: "block" | "warning"; message: string; refs?: SourceRef[] };
export type ReviewResult = { status: "READY" | "HOLD"; input: ReviewInput; findings: Finding[]; totalMinor: number };
