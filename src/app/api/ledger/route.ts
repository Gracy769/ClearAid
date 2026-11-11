import { NextRequest, NextResponse } from "next/server";
import { getLedgerEntries } from "@/lib/db";

export async function GET(req: NextRequest) {
  const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 50)));
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset") || 0));

  try {
    const { entries, headHash } = await getLedgerEntries(limit, offset);
    return NextResponse.json({
      ok: true,
      entries,
      headHash,
      count: entries.length,
    });
  } catch (error) {
    console.error("Failed to load audit ledger:", error);
    return NextResponse.json({ error: "Failed to load audit ledger." }, { status: 500 });
  }
}
