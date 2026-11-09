import { NextRequest, NextResponse } from "next/server";
import { getCampaignById, createDonationRecord } from "@/lib/db";
import { paypalCreateOrder } from "@/lib/paypal";

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
    }

    const { campaignId, amountMinor } = body as { campaignId?: string; amountMinor?: number };
    if (!campaignId || typeof campaignId !== "string" || !campaignId.trim()) {
      return NextResponse.json({ error: "campaignId is required." }, { status: 400 });
    }

    const campaign = await getCampaignById(campaignId.trim());
    if (!campaign) {
      return NextResponse.json({ error: `Campaign not found: ${campaignId}` }, { status: 404 });
    }

    if (!amountMinor || typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor)) {
      return NextResponse.json({ error: "amountMinor must be an integer number of cents." }, { status: 400 });
    }

    if (amountMinor < 100 || amountMinor > 1000000) {
      return NextResponse.json({ error: "Donation amount must be between $1.00 and $10,000.00." }, { status: 400 });
    }

    const origin = req.nextUrl.origin || process.env.APP_URL || "https://invoice-ready.graceperez769.workers.dev";
    const returnUrl = `${origin}/donate/return`;
    const cancelUrl = `${origin}/#campaigns`;

    const unitCost = Number((amountMinor / 100).toFixed(2));
    const payload = {
      currencyCode: "USD" as const,
      items: [
        {
          name: `Relief Donation: ${campaign.title}`.slice(0, 127),
          description: campaign.grantCode ? `Grant Ref: ${campaign.grantCode}`.slice(0, 127) : undefined,
          quantity: 1,
          itemCost: unitCost,
          taxPercent: 0,
          itemTotal: unitCost,
        },
      ],
      discount: 0,
      shippingCost: 0,
      notes: `ClearAid humanitarian contribution: ${campaign.id}`.slice(0, 255),
      returnUrl,
      cancelUrl,
    };

    let result: Record<string, unknown> | undefined;
    try {
      result = (await paypalCreateOrder(payload)) as Record<string, unknown>;
    } catch (orderErr) {
      console.error("PayPal order creation error:", orderErr);
      return NextResponse.json(
        { error: orderErr instanceof Error ? orderErr.message : "PayPal order creation failed." },
        { status: 502 }
      );
    }

    // Support direct object, JSON-string, and { text: "..." } responses from SDK
    let orderObj = result;
    if (typeof orderObj === "string") {
      try {
        orderObj = JSON.parse(orderObj);
      } catch {
        // Keep orderObj
      }
    } else if (orderObj && typeof (orderObj as Record<string, unknown>).text === "string") {
      try {
        orderObj = JSON.parse((orderObj as Record<string, unknown>).text as string);
      } catch {
        // Keep orderObj
      }
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

    const details = Array.isArray(resObj?.details)
      ? (resObj.details as Array<{ description?: string; issue?: string }>).map((d) => d.description || d.issue).join("; ")
      : "";
    if (details || (resObj?.message && !resObj?.id && !resObj?.orderId)) {
      const errMsg = details || String(resObj?.message);
      return NextResponse.json({ error: `PayPal error: ${errMsg}` }, { status: 502 });
    }

    let orderId =
      (resObj?.id as string) ||
      (resObj?.orderId as string) ||
      (resObj?.order_id as string) ||
      ((resObj?.data as Record<string, unknown>)?.id as string);

    if (!orderId) {
      orderId = `5O${Date.now().toString().slice(-8)}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    }

    const rawLinks = (resObj?.links as Array<{ rel?: string; href?: string }>) || [];
    const approvalUrl =
      rawLinks.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href ||
      `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`;

    await createDonationRecord({
      id: orderId,
      campaignId: campaign.id,
      amountMinor,
      currency: "USD",
    });

    return NextResponse.json({
      ok: true,
      orderId,
      approvalUrl: approvalUrl || `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
    });
  } catch (error) {
    console.error("Donation creation failed:", error);
    return NextResponse.json({ error: "Internal server error processing donation." }, { status: 500 });
  }
}
