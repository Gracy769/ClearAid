import { NextResponse } from "next/server";
import { verifyLedgerChain } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await verifyLedgerChain();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Hash chain verification failed:", error);
    return NextResponse.json({ ok: false, error: "Failed to verify hash chain." }, { status: 500 });
  }
}
