import { NextRequest, NextResponse } from "next/server";
import { extractInvoiceTerms } from "@/lib/ai";
import { extractTermsFromPdfText, extractMultiReportsFromPdfText } from "@/lib/pdf-extract";
import { runPreflight } from "@/lib/preflight";
import { newId, sign } from "@/lib/security";
import { saveReview, getCampaignById, getCampaignsWithAggregates, getDisbursements } from "@/lib/db";
import type { ReviewInput, BatchReportReview } from "@/lib/types";
import { z } from "zod";
import { createHash } from "node:crypto";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const raw = String(form.get("data") || "{}");
    const schema = z.object({
      vendorName: z.string().max(200).default(""),
      buyerName: z.string().max(200).default(""),
      buyerEmail: z.string().max(320).default(""),
      poNumber: z.string().max(120).default(""),
      currency: z.string().max(3).default("USD"),
      poCap: z.string().max(30).optional(),
      campaignId: z.string().max(100).optional(),
      items: z.array(z.object({
        description: z.string().max(500),
        quantity: z.string().max(20),
        unitAmount: z.string().max(30),
      })).max(50).default([]),
    });
    const input = schema.parse(JSON.parse(raw)) as ReviewInput;
    const file = form.get("file");
    let text = "";
    let pages: { num: number; text: string }[] = [];

    if (file instanceof File) {
      if (file.type !== "application/pdf" || file.size > 8 * 1024 * 1024) {
        return NextResponse.json({ error: "Upload a PDF no larger than 8 MB." }, { status: 400 });
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      try {
        const { extractText, getDocumentProxy } = await import("unpdf");
        const document = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: 16_777_216 });
        if (document.numPages > 100) return NextResponse.json({ error: "PDFs are limited to 100 pages." }, { status: 413 });
        const parsed = await extractText(document, { mergePages: false });
        const pageTexts = Array.isArray(parsed.text) ? parsed.text : [parsed.text];
        pages = pageTexts.map((pageText, index) => ({ num: index + 1, text: pageText }));
        text = pageTexts.join("\n").slice(0, 24000);
        input.documentHash = createHash("sha256").update(bytes).digest("hex");
      } catch (error) {
        console.error("PDF extraction failed", error instanceof Error ? error.message : "unknown");
        return NextResponse.json({ error: "Could not read this PDF. Use a text-based PDF or enter the invoice details manually." }, { status: 422 });
      }
    }

    let aiUsed = false;
    let aiError = false;

    // Check if document has multiple distinct reports / schedules
    const multi = text ? extractMultiReportsFromPdfText(text) : { isMulti: false, reports: [] };

    if (multi.isMulti && multi.reports.length > 1) {
      const batchReviews: BatchReportReview[] = [];

      for (let i = 0; i < multi.reports.length; i++) {
        const rep = multi.reports[i];
        const repInput: ReviewInput = {
          vendorName: rep.terms.vendorName || input.vendorName || "",
          buyerName: rep.terms.buyerName || input.buyerName || "",
          buyerEmail: rep.terms.buyerEmail || input.buyerEmail || "",
          poNumber: rep.terms.poNumber || (input.poNumber ? `${input.poNumber}-${i + 1}` : `PO-REP-${i + 1}`),
          currency: rep.terms.currency || input.currency || "USD",
          poCap: rep.terms.poCap || input.poCap || "",
          items: rep.terms.items && rep.terms.items.length > 0 ? rep.terms.items : input.items,
          documentHash: input.documentHash,
          sourceTerms: {
            vendorName: rep.terms.vendorName,
            buyerName: rep.terms.buyerName,
            buyerEmail: rep.terms.buyerEmail,
            poNumber: rep.terms.poNumber,
            currency: rep.terms.currency,
          },
        };

        if (text) {
          const values = [repInput.vendorName, repInput.buyerName, repInput.buyerEmail, repInput.poNumber, ...repInput.items.map(item => item.description)].filter(v => v.trim().length > 2);
          repInput.evidence = values.flatMap(value => {
            const page = pages.find(p => p.text.toLowerCase().includes(value.toLowerCase()));
            if (!page) return [];
            const at = page.text.toLowerCase().indexOf(value.toLowerCase());
            const start = Math.max(0, at - 90);
            return [{ document: file instanceof File ? file.name : "Uploaded PO/SOW", page: page.num, quote: page.text.slice(start, Math.min(page.text.length, at + value.length + 120)).replace(/\s+/g, " ").trim() }];
          }).slice(0, 20);
        }

        const repReview = runPreflight(repInput);
        const repReviewId = newId("rev");
        const repReviewHash = sign(JSON.stringify(repReview));
        await saveReview(repReviewId, repReview, repReviewHash);
        const repToken = sign(JSON.stringify({ reviewId: repReviewId, reviewHash: repReviewHash }));

        batchReviews.push({
          id: repReviewId,
          sectionTitle: rep.title,
          approvalToken: repToken,
          review: repReview,
        });
      }

      return NextResponse.json({
        reviewId: batchReviews[0].id,
        approvalToken: batchReviews[0].approvalToken,
        review: batchReviews[0].review,
        isMulti: true,
        reviews: batchReviews,
        aiUsed: false,
        aiError: false,
        pdfParsed: true,
      });
    }

    // Standard Single Report Flow
    let extracted = text ? extractTermsFromPdfText(text) : null;
    if (text) {
      try {
        const ai = await extractInvoiceTerms(text);
        if (ai) {
          aiUsed = true;
          extracted = { ...extracted, ...ai, items: ai.items?.length ? ai.items : extracted?.items };
        }
      } catch (error) {
        if (!extracted) aiError = true;
        console.error("Gemini extraction failed", error instanceof Error ? error.message : "unknown");
      }
    }

    if (extracted) {
      input.sourceTerms = { vendorName: extracted.vendorName, buyerName: extracted.buyerName, buyerEmail: extracted.buyerEmail, poNumber: extracted.poNumber, currency: extracted.currency };
      for (const key of ["vendorName", "buyerName", "buyerEmail", "poNumber", "currency"] as const) {
        if (!input[key] && extracted[key]) input[key] = extracted[key] as never;
      }
      if ((!input.poCap || input.poCap === "0" || input.poCap === "0.00") && extracted.poCap) {
        input.poCap = extracted.poCap;
      }
      const hasManualItems = input.items.some(item => item.description.trim() || item.unitAmount.trim());
      const isStaleExtraction = input.items.some(item => item.description === "Architect)" || item.description === "Spec)" || item.description === "Eng)");
      if ((!hasManualItems || isStaleExtraction) && extracted.items?.length) {
        input.items = extracted.items.slice(0, 50).map(item => ({
          description: String(item.description || "").slice(0, 500),
          quantity: String(item.quantity || "1").slice(0, 20),
          unitAmount: String(item.unitAmount || "").slice(0, 30),
        }));
      }
    }

    if (text) {
      const values = [input.vendorName, input.buyerName, input.buyerEmail, input.poNumber, ...input.items.map(item => item.description)].filter(v => v.trim().length > 2);
      input.evidence = values.flatMap(value => {
        const page = pages.find(p => p.text.toLowerCase().includes(value.toLowerCase()));
        if (!page) return [];
        const at = page.text.toLowerCase().indexOf(value.toLowerCase());
        const start = Math.max(0, at - 90);
        return [{ document: file instanceof File ? file.name : "Uploaded PO/SOW", page: page.num, quote: page.text.slice(start, Math.min(page.text.length, at + value.length + 120)).replace(/\s+/g, " ").trim() }];
      }).slice(0, 20);
    }

    // Bind Campaign SOW Rate Card and Check for Duplicate Disbursements
    let campaignId = input.campaignId;
    if (!campaignId && input.poNumber) {
      try {
        const camps = await getCampaignsWithAggregates();
        const matched = camps.find((c) =>
          c.grantCode && input.poNumber.toLowerCase().includes(c.grantCode.toLowerCase())
        );
        if (matched) campaignId = matched.id;
      } catch {}
    }

    if (campaignId) {
      try {
        const camp = await getCampaignById(campaignId);
        if (camp) {
          input.campaignId = camp.id;
          input.sourceTerms = {
            ...input.sourceTerms,
            rateCard: camp.sowRateCard || input.sourceTerms?.rateCard,
            sowHash: camp.sowHash || input.sourceTerms?.sowHash,
          };
          if (!input.poCap || input.poCap === "0" || input.poCap === "0.00") {
            input.poCap = ((camp.availableMinor ?? 0) / 100).toFixed(2);
          }

          // Check if this vendor + bill number or document hash matches an existing disbursement
          const disbs = await getDisbursements(camp.id);
          const targetPo = input.poNumber.trim().toLowerCase();
          const vendorQuery = (input.vendorName || "").trim().toLowerCase();
          const isGenericGrantCode = (ref: string) => /^grant-relief-\d+-[a-z0-9]+$/i.test(ref.trim());

          const dup = disbs.find((d) => {
            if (d.status === "FAILED") return false;

            // 1. Real file hash / document hash match
            if (input.documentHash && d.docHash && d.docHash.toLowerCase() === input.documentHash.toLowerCase()) {
              return true;
            }

            // 2. Key on vendor + specific bill/milestone number (not generic umbrella grant code)
            const vendorMatches = Boolean(
              vendorQuery &&
              ((d.vendorId && d.vendorId.toLowerCase() === vendorQuery) ||
               (d.vendorName && d.vendorName.toLowerCase() === vendorQuery) ||
               (d.vendorName && (d.vendorName.toLowerCase().includes(vendorQuery) || vendorQuery.includes(d.vendorName.toLowerCase()))))
            );

            if (vendorMatches && targetPo && !isGenericGrantCode(targetPo)) {
              if (d.poNumber && d.poNumber.trim().toLowerCase() === targetPo) return true;
              if (d.id.toLowerCase().includes(targetPo)) return true;
            }

            return false;
          });

          if (dup) {
            input.duplicateMatch = {
              existingId: dup.id,
              poNumber: dup.poNumber || input.poNumber,
              amountMinor: dup.amountMinor,
            };
          }
        }
      } catch (err) {
        console.warn("Could not bind campaign SOW rate card during preflight review:", err);
      }
    }

    const review = runPreflight(input);
    const reviewId = newId("rev");
    const reviewHash = sign(JSON.stringify(review));
    await saveReview(reviewId, review, reviewHash);
    const token = sign(JSON.stringify({ reviewId, reviewHash }));

    return NextResponse.json({
      reviewId,
      approvalToken: token,
      review,
      isMulti: false,
      aiUsed,
      aiError,
      pdfParsed: Boolean(extracted),
    });
  } catch (e) {
    console.error("review failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Could not process this review. Try manual entry or a text-based PDF." }, { status: 422 });
  }
}
