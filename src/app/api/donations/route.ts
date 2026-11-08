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
      notes: `Relief Ready Humanitarian Contribution: ${campaign.id}`.slice(0, 255),
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

    // Support both direct object and JSON-string responses
    if (result && typeof result.text === "string") {
      try {
        result = JSON.parse(result.text as string);
      } catch {
        // Keep result
      }
    }

    const orderId = (result?.id as string) || (result?.orderId as string);
    if (!orderId) {
      return NextResponse.json(
        { error: "PayPal did not return a valid order ID." },
        { status: 502 }
      );
    }

    const rawLinks = (result?.links as Array<{ rel?: string; href?: string }>) || [];
    const approvalUrl = rawLinks.find((l) => l.rel === "approve")?.href;

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
