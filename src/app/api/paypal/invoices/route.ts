import { NextRequest, NextResponse } from "next/server";
import { paypalCreateDraft } from "@/lib/paypal";
import { runPreflight } from "@/lib/preflight";
import { sign, verify } from "@/lib/security";
import type { ReviewResult } from "@/lib/types";
import { commitInvoiceDraft, getReview, releaseInvoiceDraft, reserveInvoiceDraft } from "@/lib/db";
import { toPayPalInvoiceDraft } from "@/lib/paypal-adapter";

export async function POST(req: NextRequest) {
  try {
    const { reviewId, approvalToken, review } = (await req.json()) as {
      reviewId: string;
      approvalToken: string;
      review: ReviewResult;
    };

    if (!reviewId || !review || !approvalToken) {
      return NextResponse.json(
        { error: "A reviewed invoice and approval are required." },
        { status: 400 }
      );
    }

    const stored = await getReview(reviewId);
    if (!stored) {
      return NextResponse.json(
        { error: "Review expired or was not found. Run preflight again." },
        { status: 404 }
      );
    }

    const canonical = runPreflight((stored.review as ReviewResult).input);
    if (canonical.status !== "READY" || canonical.totalMinor !== review.totalMinor) {
      return NextResponse.json(
        { error: "Review is not ready or has changed. Run preflight again." },
        { status: 409 }
      );
    }

    const approvalPayload = JSON.stringify({ reviewId, reviewHash: stored.approval_hash });
    if (
      !verify(approvalPayload, approvalToken) ||
      sign(JSON.stringify(review)) !== stored.approval_hash
    ) {
      return NextResponse.json(
        { error: "Approval is invalid or stale. Run preflight again." },
        { status: 403 }
      );
    }

    let payload: ReturnType<typeof toPayPalInvoiceDraft>;
    try {
      payload = toPayPalInvoiceDraft(review);
    } catch (adapterError) {
      return NextResponse.json(
        { error: adapterError instanceof Error ? adapterError.message : "Failed to format invoice draft." },
        { status: 400 }
      );
    }

    const pendingId = await reserveInvoiceDraft(reviewId);
    if (!pendingId) {
      return NextResponse.json(
        { error: "A PayPal invoice has already been created for this review." },
        { status: 409 }
      );
    }

    let id = "";
    let rawResult: unknown;
    let parsedObj: Record<string, unknown> = {};
    try {
      rawResult = await paypalCreateDraft(payload as unknown as Record<string, unknown>);
      if (typeof rawResult === "string") {
        try {
          parsedObj = JSON.parse(rawResult);
        } catch {
          parsedObj = {};
        }
      } else if (rawResult && typeof rawResult === "object") {
        parsedObj = rawResult as Record<string, unknown>;
      }

      id = String(parsedObj.id || parsedObj.invoice_id || "");
      if (!id && typeof parsedObj.href === "string") {
        const match = parsedObj.href.match(/\/invoices\/([A-Za-z0-9_-]+)/);
        if (match) id = match[1];
      }
      if (!id && typeof rawResult === "string") {
        const match = rawResult.match(/\/invoices\/([A-Za-z0-9_-]+)/);
        if (match) id = match[1];
      }

      if (!id) throw new Error("PayPal did not return an invoice ID.");
      await commitInvoiceDraft(pendingId, id, String(parsedObj.status || "DRAFT"));
    } catch (error) {
      await releaseInvoiceDraft(pendingId);
      throw error;
    }

    const links = Array.isArray(parsedObj.links) ? (parsedObj.links as { rel: string; href: string }[]) : [];
    const url =
      links.find((x) => x.rel === "payer-view")?.href ||
      `https://www.sandbox.paypal.com/invoice/payerView/details/${id}`;
    const sendToken = sign(JSON.stringify({ reviewId, invoiceId: id, action: "send" }));

    return NextResponse.json({ id, url, status: parsedObj.status || "DRAFT", sendToken });
  } catch (e) {
    console.error("PayPal draft failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "PayPal draft failed." },
      { status: 502 }
    );
  }
}

