import { NextResponse } from "next/server";
import { getCampaignsWithAggregates } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const campaigns = await getCampaignsWithAggregates();
    return NextResponse.json({ ok: true, campaigns });
  } catch (error) {
    console.error("Failed to load campaigns:", error);
    return NextResponse.json({ ok: false, error: "Failed to load relief campaigns." }, { status: 500 });
  }
}
