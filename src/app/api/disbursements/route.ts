import { NextRequest, NextResponse } from "next/server";
import {
  getReview,
  getVendorById,
  getCampaignById,
  reserveDisbursement,
  getDisbursements,
} from "@/lib/db";
import { checkAdminAuth, verify } from "@/lib/security";
import { runPreflight } from "@/lib/preflight";
import type { ReviewResult } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const campaignId = req.nextUrl.searchParams.get("campaignId") || undefined;
    const list = await getDisbursements(campaignId);
    return NextResponse.json({ ok: true, disbursements: list });
  } catch (error) {
    console.error("Failed to load disbursements:", error);
    return NextResponse.json({ error: "Failed to load disbursements." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!checkAdminAuth(req)) {
    return NextResponse.json({ error: "Unauthorized admin access." }, { status: 401 });
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const { reviewId, vendorId, campaignId, approvalToken } = body as {
      reviewId?: string;
      vendorId?: string;
      campaignId?: string;
      approvalToken?: string;
    };

    if (!reviewId || !approvalToken || !campaignId || !vendorId) {
      return NextResponse.json(
        { error: "reviewId, vendorId, campaignId, and approvalToken are required." },
        { status: 400 }
      );
    }

    const storedReview = await getReview(reviewId);
    if (!storedReview || !storedReview.review) {
      return NextResponse.json({ error: `Review ${reviewId} not found.` }, { status: 404 });
    }

    // Verify cryptographic HMAC approval token
    const tokenPayload = JSON.stringify({
      reviewId,
      reviewHash: storedReview.approval_hash,
    });
    if (!verify(tokenPayload, approvalToken)) {
      return NextResponse.json({ error: "Invalid or tampered approval token." }, { status: 403 });
    }

    // Check campaign exists
    const campaign = await getCampaignById(campaignId);
    if (!campaign) {
      return NextResponse.json({ error: `Campaign ${campaignId} not found.` }, { status: 404 });
    }

    // Check vendor exists in registered vetted vendors
    const vendor = await getVendorById(vendorId);
    if (!vendor) {
      return NextResponse.json(
        { error: `Vendor ${vendorId} is not registered in the admin vetted vendor registry.` },
        { status: 404 }
      );
    }

    const review = storedReview.review as ReviewResult;

    // Merge campaign SOW rate card and available pool ceiling into review input
    const auditedInput = {
      ...review.input,
      sourceTerms: {
        ...review.input.sourceTerms,
        rateCard: campaign.sowRateCard || review.input.sourceTerms?.rateCard,
        sowHash: campaign.sowHash || review.input.sourceTerms?.sowHash,
      },
      poCap:
        campaign.availableMinor !== undefined && campaign.availableMinor > 0
          ? (campaign.availableMinor / 100).toFixed(2)
          : review.input.poCap,
    };

    // Re-run deterministic preflight verification against campaign SOW rate card and pool cap
    const freshAudit = runPreflight(auditedInput);
    if (freshAudit.status !== "READY" || freshAudit.findings.some((f) => f.severity === "block")) {
      const blockReasons = freshAudit.findings
        .filter((f) => f.severity === "block")
        .map((f) => f.message)
        .join("; ");
      return NextResponse.json(
        { error: `Preflight SOW/budget audit failed: ${blockReasons}` },
        { status: 409 }
      );
    }

    // Require stored autonomous agent reconciliation approval
    if (review.agentResult?.status !== "APPROVED") {
      return NextResponse.json(
        {
          error:
            "Disbursement requires prior autonomous AI reconciliation agent approval (agent status must be APPROVED).",
        },
        { status: 409 }
      );
    }

    const amountMinor = freshAudit.totalMinor;
    const proofHash = storedReview.approval_hash;
    const disbId = `DISB-${Date.now().toString(36).toUpperCase()}-${reviewId.slice(0, 6).toUpperCase()}`;

    // Atomic reservation locking campaign row
    const reservation = await reserveDisbursement({
      id: disbId,
      campaignId,
      vendorId,
      reviewId,
      amountMinor,
      proofHash,
      currency: review.input.currency || "USD",
      poNumber: review.input.poNumber,
      docHash: storedReview.approval_hash,
    });

    if (!reservation.ok) {
      return NextResponse.json(
        { error: reservation.error || "Grant pool reservation failed: Insufficient uncommitted funds." },
        { status: 409 }
      );
    }

    return NextResponse.json({
      ok: true,
      disbursementId: disbId,
      amountMinor,
      status: "APPROVED",
    });
  } catch (error) {
    console.error("Disbursement reservation failed:", error);
    return NextResponse.json(
      { error: "Internal server error reserving disbursement." },
      { status: 500 }
    );
  }
}
