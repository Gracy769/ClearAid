import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    sandbox: true,
    paypalConfigured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    webhookConfigured: Boolean(process.env.PAYPAL_WEBHOOK_ID),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
  });
}
