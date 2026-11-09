import { NextRequest, NextResponse } from "next/server";
import {
  getDonation,
  reserveDonationCapture,
  releaseDonationCapture,
  completeDonationCapture,
} from "@/lib/db";
import { paypalCaptureOrder } from "@/lib/paypal";

const ORDER_ID_REGEX = /^[A-Z0-9]{17,32}$/;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  let reserved = false;
  let orderId = "";
  try {
    const resolvedParams = await params;
    orderId = resolvedParams.orderId;

    if (!orderId || !ORDER_ID_REGEX.test(orderId)) {
      return NextResponse.json(
        { error: "Invalid PayPal Order ID format." },
        { status: 400 }
      );
    }

    const existing = await getDonation(orderId);
    if (existing?.status === "COMPLETED") {
      return NextResponse.json({
        ok: true,
        alreadyCaptured: true,
        donation: existing,
      });
    }

    // Atomic reservation prevents race conditions and double capture
    reserved = await reserveDonationCapture(orderId);
    if (!reserved) {
      const refreshed = await getDonation(orderId);
      return NextResponse.json(
        {
          error: refreshed?.status === "COMPLETED" ? "Donation already captured." : "Donation capture currently in settlement.",
          status: refreshed?.status || "CAPTURING",
        },
        { status: 409 }
      );
    }

    let result: Record<string, unknown> | undefined;
    try {
      result = (await paypalCaptureOrder(orderId)) as Record<string, unknown>;
    } catch (captureErr) {
      console.error("PayPal order capture error:", captureErr);
      await releaseDonationCapture(orderId);
      reserved = false;
      return NextResponse.json(
        { error: captureErr instanceof Error ? captureErr.message : "PayPal order capture failed." },
        { status: 502 }
      );
    }

    if (result && typeof result.text === "string") {
      try {
        result = JSON.parse(result.text as string);
      } catch {
        // Keep result
      }
    }

    // Check for error in response
    if (result?.status === "error") {
      await releaseDonationCapture(orderId);
      reserved = false;
      return NextResponse.json(
        { error: (result?.message as string) || "PayPal refused payment capture." },
        { status: 502 }
      );
    }

    const resp = (result?.response as Record<string, unknown>) || result;
    const purchaseUnits = (resp?.purchase_units as Array<Record<string, unknown>>) || [];
    const payments = purchaseUnits[0]?.payments as Record<string, unknown> | undefined;
    const captures = (payments?.captures as Array<Record<string, unknown>>) || [];
    const captureObj = captures[0];

    const isCompleted =
      String(resp?.status || "").toUpperCase() === "COMPLETED" ||
      String(captureObj?.status || "").toUpperCase() === "COMPLETED";

    if (!isCompleted) {
      await releaseDonationCapture(orderId);
      reserved = false;
      return NextResponse.json(
        {
          error: `PayPal capture status is '${captureObj?.status || resp?.status || "UNKNOWN"}'. Only COMPLETED captures can be settled.`,
        },
        { status: 409 }
      );
    }

    const captureId = (captureObj?.id as string) || (resp?.id as string);
    if (!captureId || captureId.startsWith("CAP-")) {
      await releaseDonationCapture(orderId);
      reserved = false;
      return NextResponse.json(
        { error: "No verified PayPal capture ID returned from PayPal." },
        { status: 502 }
      );
    }

    const payer = (resp?.payer as Record<string, unknown>) || undefined;
    const payerEmail = (payer?.email_address as string) || undefined;

    const amountObj = captureObj?.amount as { value?: string } | undefined;
    const capturedAmountStr = amountObj?.value;
    if (!capturedAmountStr) {
      await releaseDonationCapture(orderId);
      reserved = false;
      return NextResponse.json(
        { error: "No capture amount returned from PayPal." },
        { status: 502 }
      );
    }

    const amountMinor = Math.round(parseFloat(capturedAmountStr) * 100);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      await releaseDonationCapture(orderId);
      reserved = false;
      return NextResponse.json(
        { error: "Invalid capture amount returned from PayPal." },
        { status: 502 }
      );
    }

    const completed = await completeDonationCapture({
      id: orderId,
      captureId,
      payerEmail,
      amountMinor,
    });

    return NextResponse.json({
      ok: true,
      donation: completed.donation,
      captureId,
    });
  } catch (error) {
    console.error("Donation capture exception:", error);
    if (reserved && orderId) {
      await releaseDonationCapture(orderId).catch(() => {});
    }
    return NextResponse.json({ error: "Internal server error during capture." }, { status: 500 });
  }
}
