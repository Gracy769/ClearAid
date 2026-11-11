import { NextRequest, NextResponse } from "next/server";
import { getVendors, saveVendor } from "@/lib/db";
import { checkAdminAuth } from "@/lib/security";

export async function GET() {
  try {
    const vendors = await getVendors();
    return NextResponse.json({ ok: true, vendors });
  } catch (error) {
    console.error("Failed to fetch vendors:", error);
    return NextResponse.json({ error: "Failed to load vendors." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!checkAdminAuth(req)) {
    return NextResponse.json({ error: "Unauthorized admin access." }, { status: 401 });
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const { id, name, payoutEmail } = body as { id?: string; name?: string; payoutEmail?: string };
    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Vendor name is required." }, { status: 400 });
    }
    if (!payoutEmail || typeof payoutEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payoutEmail.trim())) {
      return NextResponse.json({ error: "Valid payout email is required." }, { status: 400 });
    }

    const vendorId = id && id.trim() ? id.trim() : `VEND-${Date.now().toString(36).toUpperCase()}`;
    await saveVendor({
      id: vendorId,
      name: name.trim(),
      payoutEmail: payoutEmail.trim(),
      registeredBy: "ADMIN_CONSOLE",
    });

    return NextResponse.json({
      ok: true,
      vendor: { id: vendorId, name: name.trim(), payoutEmail: payoutEmail.trim() },
    });
  } catch (error) {
    console.error("Failed to register vendor:", error);
    return NextResponse.json({ error: "Internal server error registering vendor." }, { status: 500 });
  }
}
