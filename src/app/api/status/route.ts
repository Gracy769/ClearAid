import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export async function GET() {
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  let databaseConnected = false;

  if (process.env.DATABASE_URL) {
    try {
      const sql = neon(process.env.DATABASE_URL);
      await sql`SELECT 1`;
      databaseConnected = true;
    } catch {
      databaseConnected = false;
    }
  }

  return NextResponse.json({
    sandbox: true,
    paypalConfigured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    webhookConfigured: Boolean(process.env.PAYPAL_WEBHOOK_ID),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    databaseConfigured,
    databaseConnected,
    checkedAt: new Date().toISOString(),
  });
}
