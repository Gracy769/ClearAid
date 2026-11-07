import { NextRequest, NextResponse } from "next/server";
import {
  getPaypalOrder,
  reserveOrderCapture,
  releaseOrderCaptureReservation,
  updatePaypalOrderCapture,
  updateReviewStatus,
} from "@/lib/db";
import { paypalCaptureOrder } from "@/lib/paypal";

const ORDER_ID_REGEX = /^[A-Z0-9]{17,32}$/;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let reserved = false;
  let orderId = "";
  try {
    const { id } = await params;
    orderId = id;

    // Validate PayPal Order ID format
    if (!id || !ORDER_ID_REGEX.test(id)) {
      return NextResponse.json(
        { error: "Invalid PayPal Order ID format. Expected 17-32 uppercase alphanumeric characters." },
        { status: 400 }
      );
    }

    // Atomic reservation: ensures only 1 capture request can proceed (prevents double-spend race condition)
    reserved = await reserveOrderCapture(id);
    if (!reserved) {
      const existingOrder = await getPaypalOrder(id);
      return NextResponse.json(
        {
          error: existingOrder?.status === "COMPLETED"
            ? "Order already captured"
            : "Order already captured or in settlement",
          orderId: id,
          status: existingOrder?.status || "CAPTURING",
          captureId: existingOrder?.capture_id,
        },
        { status: 409 }
      );
    }

    // Correlate order record to obtain reviewId (if saved during order creation)
    const existingOrder = await getPaypalOrder(id);

    // Optional reviewId from body override if order was not previously recorded
    let bodyReviewId: string | undefined;
    try {
      const body = await req.json();
      if (body?.reviewId && typeof body.reviewId === "string") {
        bodyReviewId = body.reviewId.trim();
      }
    } catch {
      // Body is optional
    }

    const reviewId = existingOrder?.review_id || bodyReviewId;

    // Execute capture via PayPal API / toolkit
    let result: {
      status?: string;
      message?: string;
      id?: string;
      captureId?: string;
      response?: {
        id?: string;
        status?: string;
        message?: string;
        purchase_units?: Array<{
          payments?: {
            captures?: Array<{ id?: string; status?: string }>;
          };
        }>;
      };
    } | undefined;
    try {
      result = (await paypalCaptureOrder(id)) as typeof result;
    } catch (captureErr) {
      console.error("PayPal order capture error:", captureErr);
      await releaseOrderCaptureReservation(id);
      reserved = false;
      return NextResponse.json(
        { error: captureErr instanceof Error ? captureErr.message : "PayPal order capture failed." },
        { status: 502 }
      );
    }

    // Check toolkit envelope and error status
    if (
      result?.status === "error" ||
      (result?.response && result.response.status !== "COMPLETED" && result.status !== "success")
    ) {
      await releaseOrderCaptureReservation(id);
      reserved = false;
      const errorMsg =
        result?.response?.message ||
        result?.message ||
        "PayPal order capture was not completed.";
      return NextResponse.json({ error: errorMsg }, { status: 502 });
    }

    // Extract Capture ID from response envelope
    const captures = result?.response?.purchase_units?.[0]?.payments?.captures;
    const captureId: string =
      captures?.[0]?.id ||
      result?.captureId ||
      result?.response?.id ||
      result?.id ||
      "";

    // Update order status to COMPLETED
    await updatePaypalOrderCapture(id, "COMPLETED", captureId);

    // Update correlated review status to PAID
    if (reviewId) {
      await updateReviewStatus(reviewId, "PAID");
    }

    return NextResponse.json(
      {
        orderId: id,
        status: "COMPLETED",
        captureId,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Order capture route error:", err);
    if (reserved && orderId) {
      await releaseOrderCaptureReservation(orderId).catch(() => {});
    }
    return NextResponse.json(
      { error: "Internal error processing order capture." },
      { status: 500 }
    );
  }
}
