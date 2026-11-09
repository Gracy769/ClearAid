import { NextRequest, NextResponse } from "next/server";
import { getReview, savePaypalOrder } from "@/lib/db";
import { paypalCreateOrder } from "@/lib/paypal";
import type { ReviewResult } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
    }

    const reviewId = body?.reviewId;
    if (!reviewId || typeof reviewId !== "string" || !reviewId.trim()) {
      return NextResponse.json({ error: "reviewId is required" }, { status: 400 });
    }

    const stored = await getReview(reviewId.trim());
    if (!stored || !stored.review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    const review = stored.review as ReviewResult;

    // Enforce preflight audit status
    if (
      review.status !== "READY" ||
      review.findings?.some((f) => f.severity === "block")
    ) {
      return NextResponse.json(
        { error: "Review status is HOLD or not ready for settlement." },
        { status: 409 }
      );
    }

    // Orders v2 currency constraint (must be USD)
    const currency = review.input?.currency?.trim().toUpperCase();
    if (currency !== "USD") {
      return NextResponse.json(
        { error: "PayPal Orders v2 currently requires USD settlement." },
        { status: 400 }
      );
    }

    // Line items constraint
    const rawItems = review.input?.items;
    if (!rawItems || !Array.isArray(rawItems) || rawItems.length === 0) {
      return NextResponse.json(
        { error: "Invoice must have at least one line item." },
        { status: 400 }
      );
    }

    // Transform items into Orders v2 schema (floats for itemCost and itemTotal)
    const items = rawItems.map((item, idx) => {
      const qty = Math.max(1, Math.trunc(Number(item.quantity) || 1));
      const unitCost = Number(parseFloat(item.unitAmount || "0").toFixed(2));
      const itemTotal = Number((unitCost * qty).toFixed(2));
      return {
        name: (item.description || `Item ${idx + 1}`).slice(0, 127),
        description: item.description?.slice(0, 127) || undefined,
        quantity: qty,
        itemCost: unitCost,
        taxPercent: 0,
        itemTotal,
      };
    });

    const payload = {
      currencyCode: "USD" as const,
      items,
      discount: 0,
      shippingCost: 0,
      notes: review.input?.poNumber
        ? `PO: ${review.input.poNumber}`.slice(0, 255)
        : undefined,
      returnUrl: process.env.APP_URL
        ? `${process.env.APP_URL}/checkout/success`
        : "https://example.com/checkout/success",
      cancelUrl: process.env.APP_URL
        ? `${process.env.APP_URL}/checkout/cancel`
        : "https://example.com/checkout/cancel",
    };

    let result: {
      id?: string;
      status?: string;
      links?: Array<{ rel?: string; href?: string; method?: string }>;
    } | undefined;
    try {
      result = (await paypalCreateOrder(payload)) as typeof result;
    } catch (orderErr) {
      console.error("PayPal order creation error:", orderErr);
      return NextResponse.json(
        { error: orderErr instanceof Error ? orderErr.message : "PayPal order creation failed." },
        { status: 502 }
      );
    }

    let orderObj = result;
    if (typeof orderObj === "string") {
      try {
        orderObj = JSON.parse(orderObj);
      } catch {}
    } else if (orderObj && typeof (orderObj as Record<string, unknown>).text === "string") {
      try {
        orderObj = JSON.parse((orderObj as Record<string, unknown>).text as string);
      } catch {}
    }

    const resObj =
      typeof orderObj === "object" && orderObj !== null
        ? (orderObj as Record<string, unknown>)
        : undefined;

    if (resObj && "error" in resObj) {
      const errVal = resObj.error;
      const errMsg =
        typeof errVal === "object" && errVal !== null && "message" in (errVal as Record<string, unknown>)
          ? String((errVal as Record<string, unknown>).message)
          : String(errVal);
      return NextResponse.json({ error: `PayPal error: ${errMsg}` }, { status: 502 });
    }

    const orderId = (resObj?.id as string) || (resObj?.orderId as string);
    if (!orderId) {
      const msg = resObj?.message ? String(resObj.message) : "PayPal order creation did not return an order ID.";
      return NextResponse.json(
        { error: msg },
        { status: 502 }
      );
    }

    const links = Array.isArray(resObj?.links) ? (resObj.links as Array<{ rel?: string; href?: string }>) : [];
    const approvalUrl = links.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href;
    const status = (resObj?.status as string) || "CREATED";

    await savePaypalOrder(orderId, reviewId.trim(), status);

    return NextResponse.json(
      {
        orderId,
        approvalUrl,
        status: "CREATED",
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Orders route error:", err);
    return NextResponse.json(
      { error: "Internal error processing order creation." },
      { status: 500 }
    );
  }
}
