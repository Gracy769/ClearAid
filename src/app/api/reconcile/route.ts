import { NextRequest, NextResponse } from "next/server";
import { getReview, saveReview, getCampaignById } from "@/lib/db";
import { checkAdminAuth, sign } from "@/lib/security";
import { runReconciliationAgent } from "@/lib/agent/reconciliation-agent";
import type { ReviewResult } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!checkAdminAuth(req)) {
    return NextResponse.json({ error: "Unauthorized admin access." }, { status: 401 });
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
    }

    const { reviewId, campaignId } = body as { reviewId?: string; campaignId?: string };
    if (!reviewId || typeof reviewId !== "string" || !reviewId.trim()) {
      return NextResponse.json({ error: "reviewId is required." }, { status: 400 });
    }

    const stored = await getReview(reviewId.trim());
    if (!stored || !stored.review) {
      return NextResponse.json({ error: `Review ${reviewId} not found.` }, { status: 404 });
    }

    const review = stored.review as ReviewResult;
    let reviewInput = { ...review.input };

    // Attach campaign SOW rate card and available pool ceiling if campaignId is provided
    if (campaignId) {
      const campaign = await getCampaignById(campaignId.trim());
      if (campaign) {
        reviewInput = {
          ...reviewInput,
          poCap: campaign.availableMinor !== undefined ? (campaign.availableMinor / 100).toFixed(2) : reviewInput.poCap,
          sourceTerms: {
            ...reviewInput.sourceTerms,
            rateCard: campaign.sowRateCard || reviewInput.sourceTerms?.rateCard,
            sowHash: campaign.sowHash || reviewInput.sourceTerms?.sowHash,
          },
        };
      }
    }

    // Run the Autonomous ReAct Reconciliation Agent
    const agentResult = await runReconciliationAgent({
      reviewInput,
      userInstruction: "Audit this vendor bill against the campaign SOW rate card, check for duplicate billings across the campaign pool, and prepare approval if clean.",
    });

    // Save agent findings and deliberation steps back into the review record
    const updatedReview = {
      ...review,
      agentResult: {
        status: agentResult.status,
        discrepancies: agentResult.discrepancies,
        steps: agentResult.steps,
        summary: agentResult.summary,
      },
    };
    const newHash = sign(JSON.stringify(updatedReview));
    await saveReview(reviewId.trim(), updatedReview, newHash);

    return NextResponse.json({
      ok: true,
      status: agentResult.status,
      discrepancies: agentResult.discrepancies,
      steps: agentResult.steps,
      summary: agentResult.summary,
    });
  } catch (error) {
    console.error("Reconciliation agent execution failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reconciliation agent execution failed." },
      { status: 500 }
    );
  }
}
