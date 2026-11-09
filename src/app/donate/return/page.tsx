"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

interface CaptureResult {
  ok: boolean;
  captureId?: string;
  alreadyCaptured?: boolean;
  donation?: {
    id: string;
    campaignId: string;
    amountMinor: number;
    status: string;
    captureId: string;
    payerEmail?: string;
  };
  error?: string;
}

function DonateReturnContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || searchParams.get("orderId");

  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function executeCapture() {
      if (!token) {
        if (isMounted) {
          setErrorMsg("No PayPal order reference was found in the return URL.");
          setLoading(false);
        }
        return;
      }

      try {
        const res = await fetch(`/api/donations/${encodeURIComponent(token)}/capture`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const data = await res.json();
        if (!isMounted) return;

        if (res.ok && data.ok) {
          setResult(data);
        } else {
          setErrorMsg(data.error || "Failed to capture donation.");
        }
      } catch (err) {
        if (!isMounted) return;
        setErrorMsg(err instanceof Error ? err.message : "Network error during donation capture.");
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    executeCapture();

    return () => {
      isMounted = false;
    };
  }, [token]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-4 py-12">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-slate-200 p-8 text-center">
        {/* Brand Header */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="w-9 h-9 rounded-lg bg-[#0057ff] flex items-center justify-center text-white font-black text-sm tracking-tight shadow-sm">
            RR
          </div>
          <span className="font-bold text-xl text-slate-900 tracking-tight">ClearAid</span>
          <span className="ml-2 px-2 py-0.5 text-xs font-semibold rounded bg-amber-100 text-amber-800 border border-amber-300">
            Sandbox
          </span>
        </div>

        {loading && (
          <div className="py-12">
            <div className="w-12 h-12 border-4 border-[#0057ff] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <h2 className="text-xl font-bold text-slate-900 mb-2">Settling Humanitarian Donation</h2>
            <p className="text-sm text-slate-600">
              Capturing PayPal order <code className="bg-slate-100 px-1 py-0.5 rounded text-xs font-mono">{token}</code> and appending cryptographic proof to the public audit ledger...
            </p>
          </div>
        )}

        {!loading && errorMsg && (
          <div className="py-8">
            <div className="w-14 h-14 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl font-bold">
              ✕
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">Capture Error</h2>
            <p className="text-sm text-red-600 mb-6 bg-red-50 p-3 rounded-lg border border-red-200">
              {errorMsg}
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-sm font-medium transition"
              >
                Retry Capture
              </button>
              <Link
                href="/"
                className="px-4 py-2 bg-[#0057ff] hover:bg-[#0047d4] text-white rounded-lg text-sm font-medium transition shadow-sm"
              >
                Return to Campaigns
              </Link>
            </div>
          </div>
        )}

        {!loading && result?.ok && (
          <div className="py-4">
            <div className="w-14 h-14 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl font-bold">
              ✓
            </div>
            <h2 className="text-2xl font-black text-slate-900 tracking-tight mb-1">
              Donation Verified & Captured
            </h2>
            <p className="text-sm text-slate-600 mb-6">
              Funds committed directly to the verified campaign grant pool.
            </p>

            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-left space-y-3 mb-6 font-mono text-xs">
              <div className="flex justify-between items-center py-1 border-b border-slate-200">
                <span className="text-slate-500 font-sans">Captured Amount:</span>
                <span className="font-bold text-emerald-700 text-base">
                  ${((result.donation?.amountMinor || 0) / 100).toFixed(2)} USD
                </span>
              </div>
              <div className="flex justify-between items-center py-1 border-b border-slate-200">
                <span className="text-slate-500 font-sans">Campaign ID:</span>
                <span className="text-slate-800 font-semibold">{result.donation?.campaignId}</span>
              </div>
              <div className="flex justify-between items-center py-1 border-b border-slate-200">
                <span className="text-slate-500 font-sans">PayPal Order ID:</span>
                <span className="text-slate-700 truncate max-w-[200px]">{result.donation?.id || token}</span>
              </div>
              <div className="flex justify-between items-center py-1 border-b border-slate-200">
                <span className="text-slate-500 font-sans">Capture Reference:</span>
                <span className="text-slate-700 truncate max-w-[200px]">{result.captureId || result.donation?.captureId}</span>
              </div>
              <div className="flex justify-between items-center py-1">
                <span className="text-slate-500 font-sans">Public Ledger Status:</span>
                <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-sans font-bold text-[11px]">
                  SEALED IN LEDGER
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Link
                href="/#transparency-ledger"
                className="w-full py-2.5 px-4 bg-[#0057ff] hover:bg-[#0047d4] text-white rounded-xl text-sm font-semibold transition shadow-md flex items-center justify-center gap-1.5"
              >
                Inspect on Public Audit Ledger →
              </Link>
              <Link
                href="/"
                className="w-full py-2 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-medium transition"
              >
                Back to ClearAid Home
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function DonateReturnPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-50 flex items-center justify-center">
          <div className="w-10 h-10 border-4 border-[#0057ff] border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <DonateReturnContent />
    </Suspense>
  );
}
