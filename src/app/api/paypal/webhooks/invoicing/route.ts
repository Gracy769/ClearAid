import { NextRequest, NextResponse } from "next/server";
import { recordWebhook, completeDonationCapture, updateDisbursementStatus, getDonation } from "@/lib/db";
import { getPayPalAccessToken } from "@/lib/paypal";
import { assembleDisputeEvidencePackage, type PayPalDisputeEvent } from "@/lib/dispute";

export async function POST(req: NextRequest) {
  try {
    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return NextResponse.json({ error: "Failed to read request body." }, { status: 400 });
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
    }

    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const secret = process.env.PAYPAL_CLIENT_SECRET;

    if (!webhookId || !clientId || !secret) {
      return NextResponse.json(
        { error: "Webhook verification is not configured." },
        { status: 503 }
      );
    }

    // Fast-fail if required PayPal transmission headers are missing
    const authAlgo = req.headers.get("paypal-auth-algo");
    const certUrl = req.headers.get("paypal-cert-url");
    const transmissionId = req.headers.get("paypal-transmission-id");
    const transmissionSig = req.headers.get("paypal-transmission-sig");
    const transmissionTime = req.headers.get("paypal-transmission-time");

    if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
      return NextResponse.json(
        { error: "Missing required PayPal signature headers." },
        { status: 400 }
      );
    }

    // Retrieve cached OAuth token without redundant HTTP round-trips
    let accessToken: string;
    try {
      accessToken = await getPayPalAccessToken();
    } catch (tokenErr) {
      console.error("Failed to acquire PayPal OAuth token for webhook verification", tokenErr);
      return NextResponse.json({ error: "PayPal authentication failed." }, { status: 502 });
    }

    const baseUrl =
      process.env.PAYPAL_API_BASE_URL ||
      (process.env.PAYPAL_SANDBOX === "false"
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com");

    const verificationRes = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: event,
      }),
    });

    const verificationData = await verificationRes.json().catch(() => ({}));
    if (!verificationRes.ok || verificationData.verification_status !== "SUCCESS") {
      return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 });
    }

    const eventId = typeof event.id === "string" ? event.id : null;
    const eventType = typeof event.event_type === "string" ? event.event_type : null;
    if (!eventId || !eventType) {
      return NextResponse.json(
        { error: "Webhook event is missing its ID or type." },
        { status: 400 }
      );
    }

    // 1. Process Orders & Donation Captures
    if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
      const resource = (event.resource || {}) as Record<string, unknown>;
      const captureId = resource.id as string;
      const supp = resource.supplementary_data as Record<string, unknown> | undefined;
      const related = supp?.related_ids as Record<string, string> | undefined;
      const orderId = related?.order_id || captureId;
      const payer = resource.payer as Record<string, unknown> | undefined;
      const payerEmail = payer?.email_address as string | undefined;

      if (orderId && captureId) {
        await completeDonationCapture({
          id: orderId,
          captureId,
          payerEmail,
        }).catch((err) => console.error("Webhook donation capture update error:", err));
      }

      const processed = await recordWebhook(eventId, eventType, orderId, "COMPLETED");
      return NextResponse.json({
        received: true,
        duplicate: !processed,
        eventId,
        eventType,
        handled: false,
      }, { status: 200 });
    }

    if (eventType === "CHECKOUT.ORDER.APPROVED") {
      const resource = (event.resource || {}) as Record<string, unknown>;
      const orderId = resource.id as string;
      if (orderId) {
        const donation = await getDonation(orderId);
        if (donation && donation.status === "CREATED") {
          const origin = req.nextUrl.origin || process.env.APP_URL || "https://invoice-ready.graceperez769.workers.dev";
          fetch(`${origin}/api/donations/${orderId}/capture`, { method: "POST" }).catch(() => {});
        }
      }
      await recordWebhook(eventId, eventType, orderId, "APPROVED");
      return NextResponse.json({ received: true, eventId, eventType }, { status: 200 });
    }

    // 2. Process PayPal Payouts Events
    if (eventType === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED") {
      const resource = (event.resource || {}) as Record<string, unknown>;
      const payoutHeader = (resource.payout_item_header || {}) as Record<string, string>;
      const batchId = (resource.payout_batch_id || payoutHeader.payout_batch_id) as string;
      const senderBatchId = (resource.sender_batch_id || payoutHeader.sender_batch_id) as string;
      const itemId = (resource.payout_item_id || payoutHeader.payout_item_id) as string;
      const disbId = senderBatchId || batchId;

      if (disbId) {
        await updateDisbursementStatus({
          id: disbId,
          status: "PAID",
          payoutBatchId: batchId,
          payoutItemId: itemId,
        }).catch((err) => console.error("Payout webhook update error:", err));
      }

      await recordWebhook(eventId, eventType, disbId, "PAID");
      return NextResponse.json({ received: true, eventId, eventType, status: "PAID" }, { status: 200 });
    }

    if (
      eventType === "PAYMENT.PAYOUTS-ITEM.FAILED" ||
      eventType === "PAYMENT.PAYOUTS-ITEM.BLOCKED" ||
      eventType === "PAYMENT.PAYOUTS-ITEM.RETURNED" ||
      eventType === "PAYMENT.PAYOUTS-ITEM.UNCLAIMED"
    ) {
      const resource = (event.resource || {}) as Record<string, unknown>;
      const payoutHeader = (resource.payout_item_header || {}) as Record<string, string>;
      const batchId = (resource.payout_batch_id || payoutHeader.payout_batch_id) as string;
      const senderBatchId = (resource.sender_batch_id || payoutHeader.sender_batch_id) as string;
      const itemId = (resource.payout_item_id || payoutHeader.payout_item_id) as string;
      const disbId = senderBatchId || batchId;

      if (disbId) {
        await updateDisbursementStatus({
          id: disbId,
          status: "FAILED",
          payoutBatchId: batchId,
          payoutItemId: itemId,
        }).catch((err) => console.error("Payout failure webhook error:", err));
      }

      await recordWebhook(eventId, eventType, disbId, "FAILED");
      return NextResponse.json({ received: true, eventId, eventType, status: "FAILED" }, { status: 200 });
    }

    // 3. Process Customer Dispute Events (CUSTOMER.DISPUTE.*)
    if (eventType.startsWith("CUSTOMER.DISPUTE.")) {
      const disputeEvent = event as unknown as PayPalDisputeEvent;
      const resource = disputeEvent.resource || {};
      const disputeId = resource.dispute_id || eventId;

      let evidencePackage = null;
      if (eventType === "CUSTOMER.DISPUTE.CREATED") {
        evidencePackage = await assembleDisputeEvidencePackage(disputeEvent);
      }

      const processed = await recordWebhook(
        eventId,
        eventType,
        disputeId,
        resource.status || null
      );

      return NextResponse.json(
        {
          received: true,
          duplicate: !processed,
          eventId,
          eventType,
          disputeId,
          status: resource.status || "OPEN",
          evidencePackage,
        },
        { status: 200 }
      );
    }

    // 4. Process Standard Invoicing Events (INVOICING.INVOICE.*)
    if (eventType.startsWith("INVOICING.INVOICE.")) {
      const resource = (typeof event.resource === "object" && event.resource !== null ? event.resource : {}) as Record<string, unknown>;
      const invoiceId = typeof resource.id === "string" ? resource.id : typeof resource.invoice_id === "string" ? resource.invoice_id : null;
      const statusByType: Record<string, string> = {
        "INVOICING.INVOICE.PAID": "PAID",
        "INVOICING.INVOICE.CANCELLED": "CANCELLED",
        "INVOICING.INVOICE.REFUNDED": "REFUNDED",
        "INVOICING.INVOICE.PARTIALLY_PAID": "PARTIALLY_PAID",
      };

      const targetStatus = statusByType[eventType] || null;
      const processed = await recordWebhook(eventId, eventType, invoiceId, targetStatus);

      return NextResponse.json(
        {
          received: true,
          duplicate: !processed,
          eventId,
          eventType,
          invoiceId,
          status: targetStatus,
        },
        { status: 200 }
      );
    }

    // 5. Acknowledge Any Other Valid Signed PayPal Event
    const processed = await recordWebhook(eventId, eventType, null, null);
    return NextResponse.json(
      {
        received: true,
        duplicate: !processed,
        eventId,
        eventType,
        handled: false,
      },
      { status: 200 }
    );
  } catch (e) {
    console.error("Webhook processing error", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Webhook verification failed." }, { status: 500 });
  }
}
