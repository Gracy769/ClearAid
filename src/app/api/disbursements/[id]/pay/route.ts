import { NextRequest, NextResponse } from "next/server";
import {
  getDisbursementById,
  getVendorById,
  reserveDisbursementPay,
  updateDisbursementStatus,
} from "@/lib/db";
import { checkAdminAuth } from "@/lib/security";
import { getPayPalAccessToken } from "@/lib/paypal";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAdminAuth(req)) {
    return NextResponse.json({ error: "Unauthorized admin access." }, { status: 401 });
  }

  let reserved = false;
  let disbId = "";

  try {
    const { id } = await params;
    disbId = id;

    const disbursement = await getDisbursementById(id);
    if (!disbursement) {
      return NextResponse.json({ error: `Disbursement ${id} not found.` }, { status: 404 });
    }

    if (disbursement.status !== "APPROVED") {
      return NextResponse.json(
        { error: `Disbursement status is '${disbursement.status}'. Only APPROVED disbursements can be paid.` },
        { status: 409 }
      );
    }

    const vendor = await getVendorById(disbursement.vendorId);
    if (!vendor || !vendor.payoutEmail) {
      return NextResponse.json(
        { error: `Vendor ${disbursement.vendorId} has no registered payout email.` },
        { status: 400 }
      );
    }

    // Atomic state transition APPROVED -> PAYOUT_SUBMITTED prevents double payout
    reserved = await reserveDisbursementPay(id);
    if (!reserved) {
      return NextResponse.json(
        { error: "Disbursement payout is already in progress or completed." },
        { status: 409 }
      );
    }

    const accessToken = await getPayPalAccessToken();
    const baseUrl =
      process.env.PAYPAL_API_BASE_URL ||
      (process.env.PAYPAL_SANDBOX === "false"
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com");

    const payoutBody = {
      sender_batch_header: {
        sender_batch_id: id,
        email_subject: `Relief Ready Verified Payment: ${id}`,
        email_message: `Verified humanitarian disbursement under campaign ${disbursement.campaignId}`,
      },
      items: [
        {
          recipient_type: "EMAIL",
          amount: {
            value: (disbursement.amountMinor / 100).toFixed(2),
            currency: disbursement.currency || "USD",
          },
          receiver: vendor.payoutEmail,
          note: `Relief Ready Verified Disbursement ${id}`,
          sender_item_id: `item_${id}`,
        },
      ],
    };

    const payoutRes = await fetch(`${baseUrl}/v1/payments/payouts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payoutBody),
    });

    const payoutData = await payoutRes.json();
    if (!payoutRes.ok) {
      console.error("PayPal Payouts API rejected request:", payoutData);
      // Revert status back to APPROVED on failure
      await updateDisbursementStatus({ id, status: "APPROVED" });
      return NextResponse.json(
        { error: payoutData.message || "PayPal Payouts API refused payment request." },
        { status: 502 }
      );
    }

    const batchHeader = payoutData.batch_header;
    const payoutBatchId = batchHeader?.payout_batch_id || id;
    const batchStatus = batchHeader?.batch_status || "PENDING";

    // If batch succeeded or is pending, update record with batch ID
    await updateDisbursementStatus({
      id,
      status: "PAYOUT_SUBMITTED",
      payoutBatchId,
      payoutItemId: `item_${id}`,
    });

    return NextResponse.json({
      ok: true,
      disbursementId: id,
      payoutBatchId,
      batchStatus,
      status: "PAYOUT_SUBMITTED",
      vendorEmail: vendor.payoutEmail,
    });
  } catch (error) {
    console.error("Payout exception:", error);
    if (reserved && disbId) {
      await updateDisbursementStatus({ id: disbId, status: "APPROVED" }).catch(() => {});
    }
    return NextResponse.json({ error: "Internal server error executing payout." }, { status: 500 });
  }
}
