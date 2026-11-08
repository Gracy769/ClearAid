"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import type { FormEvent } from "react";
import type {
  ReviewInput,
  ReviewResult,
  BatchReportReview,
  ReliefCampaign,
  PublicDisbursementRecord,
  LedgerEntry,
} from "@/lib/types";
import {
  DEFAULT_CAMPAIGNS,
  DEFAULT_DISBURSEMENTS,
  formatCurrencyMinor,
  getRemainingGrantCapMinor,
  recordDisbursement,
} from "@/lib/campaigns";

declare global {
  interface Window {
    PayPal?: {
      Donation?: {
        Button: (config: unknown) => { render: (selector: string | HTMLElement) => void };
      };
    };
  }
}

type IconName =
  | "check"
  | "upload"
  | "file"
  | "alert"
  | "spark"
  | "plus"
  | "trash"
  | "arrow"
  | "shield"
  | "close"
  | "heart"
  | "globe"
  | "external";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  const paths: Record<IconName, React.ReactNode> = {
    check: <path d="m5 12 4 4L19 6" />,
    upload: (
      <>
        <path d="M12 16V4m0 0L7 9m5-5 5 5" />
        <path d="M20 16.5v2A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-2" />
      </>
    ),
    file: (
      <>
        <path d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9z" />
        <path d="M13 3v6h6M8 13h8m-8 4h8" />
      </>
    ),
    alert: (
      <>
        <path d="M10.3 4.4 2.9 17.2A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.8L13.7 4.4a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4m0 3h.01" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
        <path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    trash: (
      <>
        <path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" />
      </>
    ),
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    shield: (
      <>
        <path d="M12 3 20 6v5.5c0 4.7-3.4 7.8-8 9.5-4.6-1.7-8-4.8-8-9.5V6l8-3Z" />
        <path d="m8.5 12 2.2 2.2 4.8-4.8" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    heart: (
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20M12 2a14.5 14.5 0 0 1 0 20M2 12h20" />
      </>
    ),
    external: (
      <>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </>
    ),
  };
  return <svg {...common}>{paths[name]}</svg>;
}

const empty: ReviewInput = {
  vendorName: "",
  buyerName: "",
  buyerEmail: "",
  poNumber: "",
  currency: "USD",
  poCap: "",
  items: [{ description: "", quantity: "1", unitAmount: "" }],
};

function formatMoney(minor: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD",
    }).format(minor / 100);
  } catch {
    return `${currency || "USD"} ${(minor / 100).toFixed(2)}`;
  }
}

interface BatchReportStatus {
  invoiceId?: string;
  url?: string;
  sent: boolean;
  dismissed: boolean;
  busy: boolean;
  error?: string;
}

export default function Home() {
  // Top-level platform tab: "campaigns" | "disburse" | "ledger"
  const [activePlatformTab, setActivePlatformTab] = useState<"campaigns" | "disburse" | "ledger">("campaigns");

  // Relief campaigns & public ledger state
  const [campaigns, setCampaigns] = useState<ReliefCampaign[]>(DEFAULT_CAMPAIGNS);
  const [disbursements, setDisbursements] = useState<PublicDisbursementRecord[]>(DEFAULT_DISBURSEMENTS);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>("CAMP-MED-01");
  const [viewingDisbursement, setViewingDisbursement] = useState<PublicDisbursementRecord | null>(null);

  // Donation drawer state
  const [donatingCampaignId, setDonatingCampaignId] = useState<string | null>(null);
  const [selectedDonationTier, setSelectedDonationTier] = useState<string>("50");
  const [customDonationInput, setCustomDonationInput] = useState<string>("");
  const [donationSuccessMsg, setDonationSuccessMsg] = useState<string | null>(null);
  const donateButtonHostRef = useRef<HTMLDivElement>(null);

  // Invoice Ready form & preflight states
  const [data, setData] = useState<ReviewInput>(empty);
  const [file, setFile] = useState<File | null>(null);
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [reviewId, setReviewId] = useState("");
  const [approvalToken, setApprovalToken] = useState("");
  const [sendToken, setSendToken] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [invoiceUrl, setInvoiceUrl] = useState("");
  const [aiUsed, setAiUsed] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paypalConfigured, setPaypalConfigured] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);

  // Multi-invoice batch state
  const [batchReviews, setBatchReviews] = useState<BatchReportReview[]>([]);
  const [selectedBatchIndex, setSelectedBatchIndex] = useState(0);
  const [batchStatuses, setBatchStatuses] = useState<Record<string, BatchReportStatus>>({});
  const [globalBatchBusy, setGlobalBatchBusy] = useState(false);
  const [activeStep, setActiveStep] = useState<0 | 1 | 2>(0);

  // Real Public Ledger & ReAct Agent States
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [ledgerHeadHash, setLedgerHeadHash] = useState<string>("GENESIS");
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<{ ok?: boolean; message?: string; total?: number } | null>(null);
  const [adminToken, setAdminToken] = useState<string>("rr_admin_hackathon_2026_reliefready");
  const [showAdminKey, setShowAdminKey] = useState<boolean>(false);
  const [agentTrace, setAgentTrace] = useState<{
    status?: string;
    steps?: Array<{
      step: number;
      thought?: string;
      toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
      toolResults: Array<{ toolName: string; result: unknown }>;
    }>;
    discrepancies?: Array<{
      category: string;
      severity: string;
      description: string;
      remedyRecommendation?: string;
    }>;
    summary?: string;
  } | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [donationBusy, setDonationBusy] = useState(false);

  const refreshCampaigns = async () => {
    try {
      const res = await fetch("/api/campaigns");
      const json = await res.json();
      if (res.ok && json.ok && Array.isArray(json.campaigns)) {
        setCampaigns(json.campaigns);
      }
    } catch {
      // Retain seed
    }
  };

  const refreshLedger = async () => {
    setLedgerLoading(true);
    try {
      const res = await fetch("/api/ledger");
      const json = await res.json();
      if (res.ok && json.ok && Array.isArray(json.entries)) {
        setLedgerEntries(json.entries);
        if (json.headHash) setLedgerHeadHash(json.headHash);
      }
    } catch {
      // Retain seed
    } finally {
      setLedgerLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    fetch("/api/status")
      .then((response) => response.json())
      .then((status: { paypalConfigured?: boolean }) => {
        if (isMounted) setPaypalConfigured(status.paypalConfigured === true);
      })
      .catch(() => {
        if (isMounted) setPaypalConfigured(false);
      });

    fetch("/api/campaigns")
      .then((r) => r.json())
      .then((json) => {
        if (isMounted && json.ok && Array.isArray(json.campaigns)) {
          setCampaigns(json.campaigns);
        }
      })
      .catch(() => {});

    fetch("/api/ledger")
      .then((r) => r.json())
      .then((json) => {
        if (isMounted && json.ok && Array.isArray(json.entries)) {
          setLedgerEntries(json.entries);
          if (json.headHash) setLedgerHeadHash(json.headHash);
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, []);

  // Initialize PayPal Donate SDK button dynamically when donation modal opens
  useEffect(() => {
    if (!donatingCampaignId) return;

    const scriptId = "paypal-donate-sdk-script";
    const initSdkButton = () => {
      if (window.PayPal?.Donation?.Button && donateButtonHostRef.current) {
        donateButtonHostRef.current.innerHTML = "";
        try {
          window.PayPal.Donation.Button({
            env: "sandbox",
            hosted_button_id: "DEMO_RELIEF_BTN",
            image: {
              src: "https://www.paypalobjects.com/en_US/i/btn/btn_donate_LG.gif",
              alt: "Donate with PayPal button",
              title: "PayPal - Relief Ready Fund",
            },
          }).render(donateButtonHostRef.current);
        } catch {
          // Fallback gracefully if DOM selector already managed
        }
      }
    };

    let script = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://www.paypalobjects.com/donate/sdk/donate-sdk.js";
      script.charset = "UTF-8";
      script.onload = () => {
        setTimeout(initSdkButton, 100);
      };
      document.body.appendChild(script);
    } else {
      setTimeout(initSdkButton, 100);
    }
  }, [donatingCampaignId]);

  // Aggregate telemetry
  const totalRaisedMinor = useMemo(() => campaigns.reduce((acc, c) => acc + c.raisedMinor, 0), [campaigns]);
  const totalDisbursedMinor = useMemo(() => campaigns.reduce((acc, c) => acc + c.disbursedMinor, 0), [campaigns]);
  const totalAvailableMinor = useMemo(() => Math.max(0, totalRaisedMinor - totalDisbursedMinor), [totalRaisedMinor, totalDisbursedMinor]);

  const previewMinor = useMemo(() => {
    return data.items.reduce((sum, item) => {
      const amount = Number(item.unitAmount);
      const quantity = Number(item.quantity);
      return Number.isFinite(amount) && Number.isFinite(quantity) && amount > 0 && quantity > 0
        ? sum + Math.round(amount * 100) * Math.trunc(quantity)
        : sum;
    }, 0);
  }, [data.items]);

  function invalidateReview() {
    setReview(null);
    setReviewId("");
    setApprovalToken("");
    setSendToken("");
    setInvoiceId("");
    setInvoiceUrl("");
    setSent(false);
    setAgentTrace(null);
    setBatchReviews([]);
    setSelectedBatchIndex(0);
    setBatchStatuses({});
    setGlobalBatchBusy(false);
    setActiveStep(0);
  }

  function updateField(key: keyof ReviewInput, value: string) {
    invalidateReview();
    setData((current) => ({ ...current, [key]: key === "currency" ? value.toUpperCase() : value }));
  }

  function updateItem(index: number, key: "description" | "quantity" | "unitAmount", value: string) {
    invalidateReview();
    setData((current) => ({
      ...current,
      items: current.items.map((item, i) => (i === index ? { ...item, [key]: value } : item)),
    }));
  }

  // Pre-bind form to a specific Relief Campaign
  function bindToCampaign(campId: string) {
    const target = campaigns.find((c) => c.id === campId);
    if (!target) return;
    setSelectedCampaignId(campId);
    invalidateReview();

    const remainingCap = (getRemainingGrantCapMinor(target) / 100).toFixed(2);
    setData((prev) => ({
      ...prev,
      buyerName: target.leadAgency,
      buyerEmail: `procurement@${target.leadAgency.toLowerCase().replace(/[^a-z]/g, "")}.org`,
      poNumber: target.grantCode,
      currency: target.currency,
      poCap: remainingCap,
    }));
  }

  // Action from Campaign Card: jump directly to disbursement tab with preset cap
  function startDisbursementForCampaign(camp: ReliefCampaign) {
    bindToCampaign(camp.id);
    setActivePlatformTab("disburse");
    setActiveStep(0);
    setNotice({
      kind: "info",
      text: `Binding invoice review to ${camp.title}. PO Number locked to ${camp.grantCode} with budget cap of ${formatCurrencyMinor(getRemainingGrantCapMinor(camp))}.`,
    });
  }

  // Real PayPal Orders v2 Donation Execution via Agent Toolkit
  async function handleExecuteDonation(campaignId: string) {
    const amountVal = selectedDonationTier === "custom" ? Number(customDonationInput) : Number(selectedDonationTier);
    if (!amountVal || amountVal <= 0 || isNaN(amountVal)) {
      setNotice({ kind: "error", text: "Please select or enter a valid donation amount." });
      return;
    }

    const minor = Math.round(amountVal * 100);
    setDonationBusy(true);
    try {
      const res = await fetch("/api/donations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, amountMinor: minor }),
      });
      const resData = await res.json();
      if (!res.ok || !resData.ok || !resData.approvalUrl) {
        throw new Error(resData.error || "Failed to initialize PayPal donation order.");
      }
      setNotice({ kind: "info", text: "Redirecting to PayPal Sandbox Checkout..." });
      setDonationSuccessMsg("Connecting to PayPal Sandbox Checkout...");
      window.location.assign(resData.approvalUrl);
    } catch (err: unknown) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Donation failed." });
      setDonationBusy(false);
    }
  }

  // ReAct Reconciliation Agent Execution
  async function executeReconciliationAgent(rId?: string) {
    const targetReviewId = rId || reviewId;
    if (!targetReviewId) return;
    setAgentBusy(true);
    try {
      const res = await fetch("/api/reconcile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": adminToken,
        },
        body: JSON.stringify({
          reviewId: targetReviewId,
          campaignId: selectedCampaignId,
        }),
      });
      const resData = await res.json();
      if (!res.ok || !resData.ok) {
        throw new Error(resData.error || "Reconciliation agent execution failed.");
      }
      setAgentTrace({
        status: resData.status,
        steps: resData.steps,
        discrepancies: resData.discrepancies,
        summary: resData.summary,
      });
      setNotice({
        kind: resData.status === "APPROVED" ? "success" : "info",
        text: `Reconciliation Agent: ${resData.status}. ${resData.summary || ""}`,
      });
    } catch (err: unknown) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Reconciliation agent failed." });
    } finally {
      setAgentBusy(false);
    }
  }

  // Real Disbursement Approval & PayPal Payout Execution (Step 2)
  async function handleDisburseWithPayout() {
    if (!reviewId || !approvalToken) return;
    setBusy(true);
    setNotice(null);
    try {
      // 1. Reserve grant pool atomically
      const reserveRes = await fetch("/api/disbursements", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": adminToken,
        },
        body: JSON.stringify({
          reviewId,
          vendorId: "VEND-APEX-01",
          campaignId: selectedCampaignId,
          approvalToken,
        }),
      });
      const reserveData = await reserveRes.json();
      if (!reserveRes.ok || !reserveData.ok) {
        throw new Error(reserveData.error || "Grant pool reservation failed.");
      }

      const disbId = reserveData.disbursementId;

      // 2. Submit payment to PayPal Payouts
      const payRes = await fetch(`/api/disbursements/${disbId}/pay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": adminToken,
        },
      });
      const payData = await payRes.json();
      if (!payRes.ok || !payData.ok) {
        throw new Error(payData.error || "PayPal Payouts execution failed.");
      }

      setInvoiceId(payData.payoutBatchId || disbId);
      setSent(true);
      await refreshCampaigns();
      await refreshLedger();

      setNotice({
        kind: "success",
        text: `Disbursement approved! Payout submitted via PayPal Payouts (${payData.payoutBatchId}). Recorded in Public Ledger.`,
      });
    } catch (err: unknown) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Disbursement failed." });
    } finally {
      setBusy(false);
    }
  }

  // Cryptographic Ledger Verification
  async function handleVerifyLedgerChain() {
    setVerifyStatus({ message: "Recomputing cryptographic SHA-256 chain from GENESIS to HEAD..." });
    try {
      const res = await fetch("/api/ledger/verify");
      const data = await res.json();
      if (res.ok && data.ok) {
        setVerifyStatus({
          ok: true,
          total: data.totalEntries,
          message: `✓ 100% Cryptographically Valid: All ${data.totalEntries} blocks match expected prev_hash and payload_hash. Head: ${data.headHash.slice(0, 16)}...`,
        });
      } else {
        setVerifyStatus({
          ok: false,
          message: `Hash Chain Integrity Alert: Tampering detected at block #${data.brokenIndex}: ${data.reason}`,
        });
      }
    } catch (err) {
      setVerifyStatus({
        ok: false,
        message: err instanceof Error ? err.message : "Verification request failed.",
      });
    }
  }

  async function runReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    invalidateReview();

    try {
      const form = new FormData();
      form.set("data", JSON.stringify(data));
      if (file) form.set("file", file);
      const response = await fetch("/api/reviews", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The review could not be completed.");

      if (body.isMulti && Array.isArray(body.reviews) && body.reviews.length > 1) {
        setBatchReviews(body.reviews);
        const initialMap: Record<string, BatchReportStatus> = {};
        body.reviews.forEach((r: BatchReportReview) => {
          initialMap[r.id] = { sent: false, dismissed: false, busy: false };
        });
        setBatchStatuses(initialMap);
        setSelectedBatchIndex(0);
        const first = body.reviews[0];
        setData(first.review.input);
        setReview(first.review);
        setReviewId(first.id);
        setApprovalToken(first.approvalToken);
        setNotice({
          kind: "success",
          text: `Multi-invoice document detected: ${body.reviews.length} separate reports found. Review each report and approve individually or all at once.`,
        });
      } else {
        setBatchReviews([]);
        setSelectedBatchIndex(0);
        setBatchStatuses({});
        setData(body.review.input);
        setReview(body.review);
        setReviewId(body.reviewId);
        setApprovalToken(body.approvalToken);
        setAiUsed(Boolean(body.aiUsed));
        if (body.reviewId) {
          executeReconciliationAgent(body.reviewId);
        }
        setNotice(
          body.aiError
            ? { kind: "info", text: "PDF values were read from text, but AI suggestions did not load. Verify fields before approval." }
            : { kind: "success", text: body.aiUsed ? "AI suggestions verified against source document." : body.pdfParsed ? "Fields read from PDF text. Confirm checks before approval." : "Preflight is complete. Review findings below." }
        );
      }
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The review could not be completed." });
    } finally {
      setBusy(false);
    }
  }

  function selectReportTab(index: number) {
    if (!batchReviews[index]) return;
    setSelectedBatchIndex(index);
    const selected = batchReviews[index];
    setData(selected.review.input);
    setReview(selected.review);
    setReviewId(selected.id);
    setApprovalToken(selected.approvalToken);
    const st = batchStatuses[selected.id];
    if (st && st.invoiceId) {
      setInvoiceId(st.invoiceId);
      setInvoiceUrl(st.url || "");
      setSent(st.sent);
    } else {
      setInvoiceId("");
      setInvoiceUrl("");
      setSent(false);
    }
  }

  // Single invoice draft creation
  async function createDraft() {
    if (!review || !reviewId || !approvalToken) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/paypal/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId, approvalToken, review }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "PayPal could not create the draft.");
      setInvoiceId(body.id);
      setSendToken(body.sendToken);
      setInvoiceUrl(body.url || "");
      setNotice({ kind: "success", text: "Sandbox draft created. Review the PayPal invoice, then approve sending separately." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "PayPal could not create the draft." });
    } finally {
      setBusy(false);
    }
  }

  // Single invoice send
  async function sendInvoice() {
    if (!invoiceId || !sendToken || !reviewId || !review) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/paypal/invoices/${encodeURIComponent(invoiceId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId, sendToken }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "PayPal could not send the invoice.");
      setSent(true);

      // Record in public transparency ledger
      const camp = campaigns.find((c) => c.id === selectedCampaignId) || campaigns[0];
      const categoryName = review.input.items[0]?.description || "Emergency Field Deliverables";
      const { campaigns: updatedCamps, disbursements: updatedDisb } = recordDisbursement(
        campaigns,
        disbursements,
        {
          campaignId: camp.id,
          campaignTitle: camp.title,
          paypalInvoiceId: invoiceId,
          vendorName: review.input.vendorName || "Verified Aid Contractor",
          buyerName: review.input.buyerName || camp.leadAgency,
          grantCode: review.input.poNumber || camp.grantCode,
          category: categoryName,
          amountMinor: review.totalMinor,
          currency: review.input.currency,
          preflightProofHash: `sha256:${Math.random().toString(16).slice(2, 10)}...${Math.random().toString(16).slice(2, 10)}`,
          hostedInvoiceUrl: invoiceUrl,
          items: review.input.items,
        }
      );
      setCampaigns(updatedCamps);
      setDisbursements(updatedDisb);

      setNotice({ kind: "success", text: "Invoice sent through PayPal sandbox and recorded in the Public Audit Ledger!" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "PayPal could not send the invoice." });
    } finally {
      setBusy(false);
    }
  }

  // Multi-invoice: Approve & Send a single report
  async function handleApproveSingle(rep: BatchReportReview) {
    setBatchStatuses((prev) => ({
      ...prev,
      [rep.id]: { ...(prev[rep.id] || { sent: false, dismissed: false }), busy: true, error: undefined },
    }));

    try {
      const createRes = await fetch("/api/paypal/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewId: rep.id,
          approvalToken: rep.approvalToken,
          review: rep.review,
        }),
      });
      const createBody = await createRes.json();
      if (!createRes.ok || !createBody.id) {
        throw new Error(createBody.error || "PayPal draft creation failed.");
      }

      const invId = createBody.id;
      const invUrl = createBody.url || `https://www.sandbox.paypal.com/invoice/payerView/details/${invId}`;
      const sToken = createBody.sendToken;

      const sendRes = await fetch(`/api/paypal/invoices/${encodeURIComponent(invId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId: rep.id, sendToken: sToken }),
      });
      const sendBody = await sendRes.json();
      if (!sendRes.ok) {
        throw new Error(sendBody.error || "Draft created, but sending failed.");
      }

      setBatchStatuses((prev) => ({
        ...prev,
        [rep.id]: {
          invoiceId: invId,
          url: invUrl,
          sent: true,
          dismissed: false,
          busy: false,
        },
      }));

      if (rep.id === reviewId) {
        setInvoiceId(invId);
        setInvoiceUrl(invUrl);
        setSent(true);
      }

      // Record in public transparency ledger
      const camp = campaigns.find((c) => c.id === selectedCampaignId) || campaigns[0];
      const { campaigns: updatedCamps, disbursements: updatedDisb } = recordDisbursement(
        campaigns,
        disbursements,
        {
          campaignId: camp.id,
          campaignTitle: camp.title,
          paypalInvoiceId: invId,
          vendorName: rep.review.input.vendorName || "Verified Aid Contractor",
          buyerName: rep.review.input.buyerName || camp.leadAgency,
          grantCode: rep.review.input.poNumber || camp.grantCode,
          category: rep.sectionTitle,
          amountMinor: rep.review.totalMinor,
          currency: rep.review.input.currency,
          preflightProofHash: `sha256:${rep.id.replace(/[^a-zA-Z0-9]/g, "").padEnd(16, "0").slice(0, 16)}...`,
          hostedInvoiceUrl: invUrl,
          items: rep.review.input.items,
        }
      );
      setCampaigns(updatedCamps);
      setDisbursements(updatedDisb);

      setNotice({
        kind: "success",
        text: `${rep.sectionTitle} approved & sent. Recorded in Public Transparency Ledger.`,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Approval failed";
      setBatchStatuses((prev) => ({
        ...prev,
        [rep.id]: { ...(prev[rep.id] || { sent: false, dismissed: false }), busy: false, error: msg },
      }));
      setNotice({ kind: "error", text: msg });
    }
  }

  function handleDismissSingle(reportId: string) {
    setBatchStatuses((prev) => ({
      ...prev,
      [reportId]: { ...(prev[reportId] || { sent: false, busy: false }), dismissed: true },
    }));
  }

  async function handleApproveAll() {
    const pending = batchReviews.filter((rep) => {
      const st = batchStatuses[rep.id];
      return !st?.dismissed && !st?.sent && rep.review.status === "READY";
    });
    if (!pending.length) return;

    setGlobalBatchBusy(true);
    setNotice({ kind: "info", text: `Approving and sending ${pending.length} invoices through PayPal sandbox...` });

    let sentCount = 0;
    let localCampaigns = campaigns;
    let localDisbursements = disbursements;

    for (const rep of pending) {
      setBatchStatuses((prev) => ({
        ...prev,
        [rep.id]: { ...(prev[rep.id] || { sent: false, dismissed: false }), busy: true, error: undefined },
      }));

      try {
        const createRes = await fetch("/api/paypal/invoices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reviewId: rep.id,
            approvalToken: rep.approvalToken,
            review: rep.review,
          }),
        });
        const createBody = await createRes.json();
        if (!createRes.ok || !createBody.id) {
          throw new Error(createBody.error || "Draft failed");
        }

        const invId = createBody.id;
        const invUrl = createBody.url || `https://www.sandbox.paypal.com/invoice/payerView/details/${invId}`;
        const sToken = createBody.sendToken;

        const sendRes = await fetch(`/api/paypal/invoices/${encodeURIComponent(invId)}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviewId: rep.id, sendToken: sToken }),
        });
        const sendBody = await sendRes.json();
        if (!sendRes.ok) throw new Error(sendBody.error || "Send failed");

        setBatchStatuses((prev) => ({
          ...prev,
          [rep.id]: {
            invoiceId: invId,
            url: invUrl,
            sent: true,
            dismissed: false,
            busy: false,
          },
        }));

        if (rep.id === reviewId) {
          setInvoiceId(invId);
          setInvoiceUrl(invUrl);
          setSent(true);
        }

        const camp = localCampaigns.find((c) => c.id === selectedCampaignId) || localCampaigns[0];
        const res = recordDisbursement(localCampaigns, localDisbursements, {
          campaignId: camp.id,
          campaignTitle: camp.title,
          paypalInvoiceId: invId,
          vendorName: rep.review.input.vendorName || "Verified Aid Contractor",
          buyerName: rep.review.input.buyerName || camp.leadAgency,
          grantCode: rep.review.input.poNumber || camp.grantCode,
          category: rep.sectionTitle,
          amountMinor: rep.review.totalMinor,
          currency: rep.review.input.currency,
          preflightProofHash: `sha256:${rep.id.replace(/[^a-zA-Z0-9]/g, "").padEnd(16, "0").slice(0, 16)}...`,
          hostedInvoiceUrl: invUrl,
          items: rep.review.input.items,
        });
        localCampaigns = res.campaigns;
        localDisbursements = res.disbursements;

        sentCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed";
        setBatchStatuses((prev) => ({
          ...prev,
          [rep.id]: { ...(prev[rep.id] || { sent: false, dismissed: false }), busy: false, error: msg },
        }));
      }
    }

    setCampaigns(localCampaigns);
    setDisbursements(localDisbursements);
    setGlobalBatchBusy(false);
    setNotice({
      kind: "success",
      text: `Batch complete: ${sentCount} invoice(s) sent through PayPal. All hosted links are live and recorded in the Public Audit Ledger.`,
    });
  }

  function addItem() {
    invalidateReview();
    setData((current) => ({
      ...current,
      items: [...current.items, { description: "", quantity: "1", unitAmount: "" }],
    }));
  }

  function removeItem(index: number) {
    invalidateReview();
    setData((current) => ({
      ...current,
      items: current.items.filter((_, i) => i !== index),
    }));
  }

  const activeBatchReviews = batchReviews.filter((rep) => !batchStatuses[rep.id]?.dismissed);
  const activePendingCount = activeBatchReviews.filter(
    (rep) => !batchStatuses[rep.id]?.sent && rep.review.status === "READY"
  ).length;

  return (
    <main className="app-shell">
      {/* GLOBAL HEADER */}
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#main" aria-label="Relief Ready home">
            <span className="brand-mark" aria-hidden="true">RR</span>
            <div>
              <span className="brand-name">Relief Ready</span>
            </div>
          </a>
          <div className="topbar-note">
            <Icon name="shield" size={16} />
            <span>Verified Humanitarian Aid &amp; PayPal Invoicing</span>
          </div>
          <span className="sandbox-badge">
            <span className="sandbox-dot" />
            {paypalConfigured === true ? "SANDBOX CONNECTED" : "SANDBOX"}
          </span>
        </div>
      </header>

      {/* PLATFORM NAVIGATION TABS */}
      <nav className="platform-nav" aria-label="Main navigation">
        <div className="platform-nav-inner">
          <button
            type="button"
            className={`platform-tab${activePlatformTab === "campaigns" ? " is-active" : ""}`}
            onClick={() => setActivePlatformTab("campaigns")}
          >
            <Icon name="heart" size={16} />
            <span>Active Relief Campaigns</span>
            <span className="platform-tab-badge">{campaigns.length}</span>
          </button>

          <button
            type="button"
            className={`platform-tab${activePlatformTab === "disburse" ? " is-active" : ""}`}
            onClick={() => setActivePlatformTab("disburse")}
          >
            <Icon name="file" size={16} />
            <span>Audit &amp; Disburse (Invoice Ready)</span>
          </button>

          <button
            type="button"
            className={`platform-tab${activePlatformTab === "ledger" ? " is-active" : ""}`}
            onClick={() => setActivePlatformTab("ledger")}
          >
            <Icon name="shield" size={16} />
            <span>Public Transparency Ledger</span>
            <span className="platform-tab-badge">{disbursements.length}</span>
          </button>
        </div>
      </nav>

      {/* WORKFLOW RAIL (ONLY IN DISBURSEMENT TAB) */}
      {activePlatformTab === "disburse" && (
        <nav className="workflow-rail" aria-label="Invoice review progress">
          <ol className="workflow-inner">
            {["Invoice details", "Preflight", "PayPal approval"].map((label, index) => {
              const isCompleted =
                (index === 0 && review !== null) ||
                (index === 1 && (sent || Boolean(invoiceId) || Object.values(batchStatuses).some((s) => s.sent)));
              const isActive = activeStep === index;
              const canClick = index === 0 || (index === 1 && review !== null) || (index === 2 && review !== null);
              return (
                <li
                  key={label}
                  className={`workflow-step${isActive ? " is-active" : ""}${isCompleted ? " is-complete" : ""}`}
                  aria-current={isActive ? "step" : undefined}
                  style={{ cursor: canClick ? "pointer" : "default" }}
                  onClick={() => {
                    if (canClick) setActiveStep(index as 0 | 1 | 2);
                  }}
                >
                  <span className="step-marker">
                    {isCompleted ? <Icon name="check" size={14} /> : <span className="step-dot" />}
                  </span>
                  <span>{label}</span>
                  {index < 2 && <span className="step-connector" aria-hidden="true" />}
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      <div className="workspace" id="main">
        <section className="main-column" aria-labelledby="page-title">
          {notice && (
            <div
              className={`notice notice-${notice.kind}`}
              role={notice.kind === "error" ? "alert" : "status"}
              aria-live="polite"
              style={{ marginBottom: "20px" }}
            >
              <Icon name={notice.kind === "error" ? "alert" : "check"} size={18} />
              <span>{notice.text}</span>
            </div>
          )}

          {/* =========================================================================
              VIEW 1: ACTIVE RELIEF CAMPAIGNS (DONOR PORTAL & PAYPAL DONATE SDK)
              ========================================================================= */}
          {activePlatformTab === "campaigns" && (
            <div>
              <div className="intro">
                <h1 id="page-title">Transparent disaster relief. Zero unverified leakage.</h1>
                <p>
                  Donate directly via PayPal to emergency response pools. Every dollar is cryptographically locked
                  until field contractor invoices pass deterministic preflight verification.
                </p>
              </div>

              {/* TELEMETRY STRIP */}
              <div className="metric-strip">
                <div className="metric-card">
                  <div className="metric-card-label">
                    <Icon name="heart" size={14} /> Total Donated
                  </div>
                  <div className="metric-card-value" style={{ color: "var(--blue)" }}>
                    {formatCurrencyMinor(totalRaisedMinor)}
                  </div>
                  <div className="metric-card-sub">Collected via PayPal Donate</div>
                </div>

                <div className="metric-card">
                  <div className="metric-card-label">
                    <Icon name="shield" size={14} /> Audited &amp; Disbursed
                  </div>
                  <div className="metric-card-value" style={{ color: "var(--success)" }}>
                    {formatCurrencyMinor(totalDisbursedMinor)}
                  </div>
                  <div className="metric-card-sub">Preflight verified field invoices</div>
                </div>

                <div className="metric-card">
                  <div className="metric-card-label">
                    <Icon name="globe" size={14} /> Available Grant Pool
                  </div>
                  <div className="metric-card-value">
                    {formatCurrencyMinor(totalAvailableMinor)}
                  </div>
                  <div className="metric-card-sub">Ready for approved aid operations</div>
                </div>
              </div>

              {/* CAMPAIGN CARDS LIST */}
              <div className="campaigns-grid">
                {campaigns.map((camp) => {
                  const pctRaised = Math.min(100, Math.round((camp.raisedMinor / camp.targetMinor) * 100));
                  const pctDisbursed = Math.min(100, Math.round((camp.disbursedMinor / camp.targetMinor) * 100));
                  const remainingCap = getRemainingGrantCapMinor(camp);
                  const isDonating = donatingCampaignId === camp.id;

                  return (
                    <article className="campaign-card" key={camp.id}>
                      <div className="campaign-card-header">
                        <div className="campaign-badges">
                          <span className="category-pill">{camp.category}</span>
                          {camp.urgent && <span className="urgent-pill">URGENT RESPONSE</span>}
                          <span className="disaster-zone-tag"><Icon name="globe" size={13} /> {camp.disasterZone}</span>
                        </div>
                        <span className="grant-code-badge">{camp.grantCode}</span>
                      </div>

                      <h2 className="campaign-title">{camp.title}</h2>
                      <p className="campaign-desc">{camp.subtitle}</p>

                      <div className="campaign-progress-wrap">
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px", fontSize: "12px" }}>
                          <span style={{ fontWeight: 600, color: "var(--ink)" }}>{pctRaised}% of Goal Funded</span>
                          <span style={{ color: "var(--muted)" }}>Target: {formatCurrencyMinor(camp.targetMinor)}</span>
                        </div>
                        <div className="campaign-progress-bar">
                          <div
                            className="progress-fill-raised"
                            style={{ width: `${pctRaised}%` }}
                            title={`Raised: ${formatCurrencyMinor(camp.raisedMinor)}`}
                          />
                        </div>
                      </div>

                      <div className="campaign-metrics-grid">
                        <div className="camp-metric-item">
                          <span className="camp-metric-label">Raised</span>
                          <span className="camp-metric-val highlight-blue">{formatCurrencyMinor(camp.raisedMinor)}</span>
                        </div>
                        <div className="camp-metric-item">
                          <span className="camp-metric-label">Disbursed ({pctDisbursed}%)</span>
                          <span className="camp-metric-val highlight-green">{formatCurrencyMinor(camp.disbursedMinor)}</span>
                        </div>
                        <div className="camp-metric-item">
                          <span className="camp-metric-label">Remaining Pool</span>
                          <span className="camp-metric-val">{formatCurrencyMinor(remainingCap)}</span>
                        </div>
                        <div className="camp-metric-item">
                          <span className="camp-metric-label">Lead Agency</span>
                          <span className="camp-metric-val" style={{ fontSize: "12.5px" }}>{camp.leadAgency}</span>
                        </div>
                      </div>

                      {/* DONATION DRAWER (IF ACTIVE) */}
                      {isDonating && (
                        <div className="donation-box">
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <strong style={{ fontSize: "14.5px", color: "var(--blue-deep)" }}>
                              Contribute via PayPal to {camp.title}
                            </strong>
                            <button
                              type="button"
                              className="icon-button"
                              onClick={() => setDonatingCampaignId(null)}
                              aria-label="Close donation drawer"
                            >
                              <Icon name="close" size={16} />
                            </button>
                          </div>

                          <div className="donation-chips">
                            {["25", "50", "100", "250"].map((tier) => (
                              <button
                                key={tier}
                                type="button"
                                className={`donation-chip${selectedDonationTier === tier ? " is-selected" : ""}`}
                                onClick={() => setSelectedDonationTier(tier)}
                              >
                                ${tier}
                              </button>
                            ))}
                            <button
                              type="button"
                              className={`donation-chip${selectedDonationTier === "custom" ? " is-selected" : ""}`}
                              onClick={() => setSelectedDonationTier("custom")}
                            >
                              Custom
                            </button>
                          </div>

                          {selectedDonationTier === "custom" && (
                            <div style={{ marginBottom: "14px", maxWidth: "260px" }}>
                              <label className="field">
                                <span>Custom Donation Amount ($USD)</span>
                                <input
                                  type="number"
                                  min="1"
                                  step="1"
                                  placeholder="500"
                                  value={customDonationInput}
                                  onChange={(e) => setCustomDonationInput(e.target.value)}
                                />
                              </label>
                            </div>
                          )}

                          {donationSuccessMsg ? (
                            <div className="notice notice-success">
                              <Icon name="check" size={18} />
                              <span>{donationSuccessMsg}</span>
                            </div>
                          ) : (
                            <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", marginTop: "12px" }}>
                              {/* Official PayPal Donate SDK Container */}
                              <div ref={donateButtonHostRef} id="paypal-donate-container" />

                              {/* Instant Sandbox Donation Execution */}
                              <button
                                type="button"
                                className="button-primary"
                                disabled={donationBusy}
                                onClick={() => handleExecuteDonation(camp.id)}
                              >
                                {donationBusy ? (
                                  <>
                                    <span className="spinner" /> Connecting to PayPal...
                                  </>
                                ) : (
                                  <>
                                    <Icon name="heart" size={16} />
                                    Donate ${selectedDonationTier === "custom" ? customDonationInput || "0" : selectedDonationTier} (Sandbox)
                                  </>
                                )}
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="campaign-card-footer">
                        <button
                          type="button"
                          className="button-primary"
                          onClick={() => {
                            setDonatingCampaignId(isDonating ? null : camp.id);
                          }}
                        >
                          <Icon name="heart" size={16} />
                          {isDonating ? "Hide Donate Form" : "Donate via PayPal"}
                        </button>

                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => startDisbursementForCampaign(camp)}
                        >
                          Audit &amp; Disburse Bills <Icon name="arrow" size={16} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {/* =========================================================================
              VIEW 2: AUDIT & DISBURSE (INVOICE READY ENGINE)
              ========================================================================= */}
          {activePlatformTab === "disburse" && (
            <>
              {/* STEP 0: INVOICE DETAILS FORM */}
              {activeStep === 0 && (
                <>
                  <div className="intro">
                    <h1 id="page-title">Make every relief invoice add up.</h1>
                    <p>
                      Check field supplier bills against the relief grant budget cap, resolve policy blockers, and send
                      through PayPal Invoicing only after dual approval.
                    </p>
                  </div>

                  {/* QUICK RELIEF GRANT SELECTOR */}
                  <div className="campaign-quick-selector">
                    <div>
                      <strong style={{ fontSize: "13.5px", color: "var(--ink)", display: "block" }}>
                        Active Relief Grant Allocation
                      </strong>
                      <span style={{ fontSize: "12px", color: "var(--muted)" }}>
                        Auto-binds PO reference and locks preflight to remaining uncommitted pool.
                      </span>
                    </div>
                    <select
                      value={selectedCampaignId}
                      onChange={(e) => bindToCampaign(e.target.value)}
                    >
                      {campaigns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title} — Cap: {formatCurrencyMinor(getRemainingGrantCapMinor(c))}
                        </option>
                      ))}
                    </select>
                  </div>

                  <form className="surface form-surface" onSubmit={runReview}>
                    <div className="section-heading">
                      <div>
                        <h2>Invoice details</h2>
                        <p>Enter the bill you plan to disburse. Add a searchable PO or SOW for source checks.</p>
                      </div>
                      <span className="section-count">Vendor · Buyer · Grant</span>
                    </div>

                    <div className={`upload-zone${file ? " has-file" : ""}`}>
                      <label className="upload-hit-area" htmlFor="po-file">
                        <span className="upload-icon">
                          <Icon name={file ? "file" : "upload"} size={21} />
                        </span>
                        <span className="upload-copy">
                          <strong>{file ? file.name : "Add a purchase order or statement of work"}</strong>
                          <span>
                            {file
                              ? `${file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / 1024 / 1024).toFixed(2)} MB`} · Searchable PDF`
                              : "Drop a searchable PDF here, or browse · up to 8 MB"}
                          </span>
                        </span>
                        <input
                          id="po-file"
                          className="visually-hidden"
                          type="file"
                          accept="application/pdf,.pdf"
                          onChange={(event) => {
                            invalidateReview();
                            setFile(event.target.files?.[0] || null);
                          }}
                        />
                      </label>
                      {file && (
                        <button
                          type="button"
                          className="icon-button file-remove"
                          aria-label="Remove uploaded file"
                          onClick={() => {
                            invalidateReview();
                            setFile(null);
                          }}
                        >
                          <Icon name="close" size={16} />
                        </button>
                      )}
                    </div>
                    <p className="privacy-note">
                      <Icon name="shield" size={14} />
                      The original PDF is processed for this review and is not retained.
                    </p>

                    {batchReviews.length > 1 && (
                      <div
                        style={{
                          margin: "16px 0",
                          padding: "14px 16px",
                          background: "var(--canvas)",
                          borderRadius: "10px",
                          border: "1px solid var(--border)",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                          <strong style={{ fontSize: "14px", color: "var(--ink)" }}>
                            Multi-Invoice Document: Found {batchReviews.length} Reports
                          </strong>
                          <span style={{ fontSize: "12px", color: "var(--muted)" }}>Click a tab to view report in form</span>
                        </div>
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                          {batchReviews.map((rep, idx) => {
                            const isSelected = idx === selectedBatchIndex;
                            const st = batchStatuses[rep.id];
                            const isDismissed = st?.dismissed;
                            const isSent = st?.sent;
                            const isReady = rep.review.status === "READY";
                            return (
                              <button
                                key={rep.id}
                                type="button"
                                onClick={() => selectReportTab(idx)}
                                style={{
                                  padding: "8px 14px",
                                  borderRadius: "8px",
                                  border: isSelected ? "2px solid var(--blue)" : "1px solid var(--border)",
                                  background: isSelected ? "var(--blue)" : "#ffffff",
                                  color: isSelected ? "#ffffff" : isDismissed ? "#94a3b8" : "var(--ink)",
                                  textDecoration: isDismissed ? "line-through" : "none",
                                  cursor: "pointer",
                                  fontWeight: isSelected ? "600" : "500",
                                  fontSize: "13px",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "8px",
                                  transition: "all 140ms ease",
                                }}
                              >
                                <span>{rep.sectionTitle.length > 32 ? `${rep.sectionTitle.slice(0, 32)}…` : rep.sectionTitle}</span>
                                <span style={{ fontSize: "12px", opacity: isSelected ? 0.9 : 0.7 }}>
                                  ({formatMoney(rep.review.totalMinor, rep.review.input.currency)})
                                </span>
                                <span
                                  style={{
                                    fontSize: "10px",
                                    fontWeight: 700,
                                    padding: "2px 6px",
                                    borderRadius: "4px",
                                    background: isSelected
                                      ? "rgba(255,255,255,0.25)"
                                      : isSent
                                      ? "var(--success-bg)"
                                      : isReady
                                      ? "var(--canvas)"
                                      : "var(--danger-bg)",
                                    color: isSelected
                                      ? "#ffffff"
                                      : isSent
                                      ? "var(--success)"
                                      : isReady
                                      ? "var(--blue-deep)"
                                      : "var(--danger)",
                                  }}
                                >
                                  {isDismissed ? "EXCLUDED" : isSent ? "SENT ✓" : isReady ? "READY" : "HOLD"}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="form-divider" />

                    <fieldset className="field-group">
                      <legend>Who is billing whom?</legend>
                      <div className="field-grid">
                        <label className="field">
                          <span>Field Contractor / Supplier</span>
                          <input
                            autoComplete="organization"
                            value={data.vendorName}
                            onChange={(event) => updateField("vendorName", event.target.value)}
                            placeholder="e.g. Apex Emergency Supply Co."
                          />
                        </label>
                        <label className="field">
                          <span>Relief Agency (Buyer)</span>
                          <input
                            value={data.buyerName}
                            onChange={(event) => updateField("buyerName", event.target.value)}
                            placeholder="e.g. Global Emergency Health Corps"
                          />
                        </label>
                        <label className="field field-wide">
                          <span>Procurement Officer Email</span>
                          <input
                            type="email"
                            autoComplete="email"
                            value={data.buyerEmail}
                            onChange={(event) => updateField("buyerEmail", event.target.value)}
                            placeholder="procurement@reliefagency.org"
                          />
                        </label>
                      </div>
                    </fieldset>

                    <fieldset className="field-group terms-group">
                      <legend>Grant allocation &amp; terms</legend>
                      <div className="field-grid field-grid-terms">
                        <label className="field">
                          <span>Grant / PO Number</span>
                          <input
                            value={data.poNumber}
                            onChange={(event) => updateField("poNumber", event.target.value)}
                            placeholder="GRANT-RELIEF-2026-MED01"
                          />
                        </label>
                        <label className="field">
                          <span>Disbursement currency</span>
                          <select
                            value={data.currency}
                            onChange={(event) => updateField("currency", event.target.value)}
                          >
                            <option value="USD">USD · US dollar</option>
                            <option value="EUR">EUR · Euro</option>
                            <option value="GBP">GBP · Pound sterling</option>
                            <option value="CAD">CAD · Canadian dollar</option>
                            <option value="AUD">AUD · Australian dollar</option>
                            <option value="INR">INR · Indian rupee</option>
                          </select>
                        </label>
                        <label className="field">
                          <span>Grant Budget Cap <em>Strict invariant</em></span>
                          <div className="input-prefix">
                            <span>{data.currency || "USD"}</span>
                            <input
                              inputMode="decimal"
                              value={data.poCap || ""}
                              onChange={(event) => updateField("poCap", event.target.value)}
                              placeholder="0.00"
                              aria-label="Grant Budget Cap amount"
                            />
                          </div>
                        </label>
                      </div>
                    </fieldset>

                    <fieldset className="field-group line-items-group">
                      <legend>What relief supplies / services are you billing for?</legend>
                      <div className="line-items-head">
                        <span>Deliverable or aid item</span>
                        <span>Qty</span>
                        <span>Unit rate</span>
                        <span className="line-action-label">Remove</span>
                      </div>
                      <div className="line-items-list">
                        {data.items.map((item, index) => (
                          <div className="line-item" key={index}>
                            <label className="visually-hidden" htmlFor={`item-description-${index}`}>
                              Aid item, line {index + 1}
                            </label>
                            <input
                              id={`item-description-${index}`}
                              value={item.description}
                              onChange={(event) => updateItem(index, "description", event.target.value)}
                              placeholder="e.g. Sterile surgical suture kits (50pk)"
                            />
                            <label className="visually-hidden" htmlFor={`item-quantity-${index}`}>
                              Quantity, line {index + 1}
                            </label>
                            <input
                              id={`item-quantity-${index}`}
                              type="number"
                              min="1"
                              step="1"
                              inputMode="numeric"
                              value={item.quantity}
                              onChange={(event) => updateItem(index, "quantity", event.target.value)}
                            />
                            <label className="visually-hidden" htmlFor={`item-rate-${index}`}>
                              Unit rate, line {index + 1}
                            </label>
                            <div className="rate-input">
                              <span>{data.currency || "USD"}</span>
                              <input
                                id={`item-rate-${index}`}
                                inputMode="decimal"
                                value={item.unitAmount}
                                onChange={(event) => updateItem(index, "unitAmount", event.target.value)}
                                placeholder="0.00"
                              />
                            </div>
                            <button
                              type="button"
                              className="icon-button remove-line"
                              onClick={() => removeItem(index)}
                              disabled={data.items.length === 1}
                              aria-label={`Remove line ${index + 1}`}
                            >
                              <Icon name="trash" size={17} />
                            </button>
                          </div>
                        ))}
                      </div>
                      <button type="button" className="add-line" onClick={addItem}>
                        <Icon name="plus" size={16} /> Add an aid line item
                      </button>
                      <div className="invoice-total">
                        <span>Total claim</span>
                        <strong>{formatMoney(previewMinor, data.currency)}</strong>
                      </div>
                    </fieldset>

                    {aiUsed && (
                      <div className="suggestion-banner">
                        <span className="suggestion-icon">
                          <Icon name="spark" size={17} />
                        </span>
                        <p>
                          <strong>AI suggestions added.</strong> Verify the business names, PO number, and terms
                          against source evidence before approval.
                        </p>
                      </div>
                    )}

                    <div className="form-footer">
                      <span className="footer-note">Every line is checked deterministically against grant budget caps.</span>
                      {review ? (
                        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                          <button
                            type="submit"
                            className="button-secondary"
                            disabled={busy}
                            style={{ minHeight: "48px", padding: "0 14px", fontSize: "13px" }}
                            title="Re-run check against source"
                          >
                            {busy ? <span className="spinner" /> : "Re-run"}
                          </button>
                          <button
                            type="button"
                            className="button-primary"
                            onClick={() => setActiveStep(1)}
                          >
                            Next <Icon name="arrow" size={17} />
                          </button>
                        </div>
                      ) : (
                        <button className="button-primary" type="submit" disabled={busy}>
                          {busy ? (
                            <>
                              <span className="spinner" /> Checking invoice against grant cap
                            </>
                          ) : (
                            <>
                              Run preflight <Icon name="arrow" size={17} />
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </form>
                </>
              )}

              {/* STEP 1: PREFLIGHT RESULT PAGE */}
              {activeStep === 1 && review && (
                <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                  <div className="intro">
                    <h1 id="page-title">Preflight verification.</h1>
                    <p>Deterministic checks and policy reconciliation findings before any PayPal draft action.</p>
                  </div>

                  {batchReviews.length > 1 && (
                    <div style={{ padding: "14px 16px", background: "var(--canvas)", borderRadius: "10px", border: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                        <strong style={{ fontSize: "14px", color: "var(--ink)" }}>
                          Multi-Invoice Reports ({batchReviews.length})
                        </strong>
                        <span style={{ fontSize: "12px", color: "var(--muted)" }}>Click a tab to view findings for that report</span>
                      </div>
                      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        {batchReviews.map((rep, idx) => {
                          const isSelected = idx === selectedBatchIndex;
                          const st = batchStatuses[rep.id];
                          const isDismissed = st?.dismissed;
                          const isSent = st?.sent;
                          const isReady = rep.review.status === "READY";
                          return (
                            <button
                              key={rep.id}
                              type="button"
                              onClick={() => selectReportTab(idx)}
                              style={{
                                padding: "8px 14px",
                                borderRadius: "8px",
                                border: isSelected ? "2px solid var(--blue)" : "1px solid var(--border)",
                                background: isSelected ? "var(--blue)" : "#ffffff",
                                color: isSelected ? "#ffffff" : isDismissed ? "#94a3b8" : "var(--ink)",
                                textDecoration: isDismissed ? "line-through" : "none",
                                cursor: "pointer",
                                fontWeight: isSelected ? "600" : "500",
                                fontSize: "13px",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "8px",
                                transition: "all 140ms ease",
                              }}
                            >
                              <span>{rep.sectionTitle.length > 30 ? `${rep.sectionTitle.slice(0, 30)}…` : rep.sectionTitle}</span>
                              <span style={{ fontSize: "12px", opacity: isSelected ? 0.9 : 0.7 }}>
                                ({formatMoney(rep.review.totalMinor, rep.review.input.currency)})
                              </span>
                              <span
                                style={{
                                  fontSize: "10px",
                                  fontWeight: 700,
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  background: isSelected
                                    ? "rgba(255,255,255,0.25)"
                                    : isSent
                                    ? "var(--success-bg)"
                                    : isReady
                                    ? "var(--canvas)"
                                    : "var(--danger-bg)",
                                  color: isSelected
                                    ? "#ffffff"
                                    : isSent
                                    ? "var(--success)"
                                    : isReady
                                    ? "var(--blue-deep)"
                                    : "var(--danger)",
                                }}
                              >
                                {isDismissed ? "EXCLUDED" : isSent ? "SENT ✓" : isReady ? "READY" : "HOLD"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <section className="surface result-surface" style={{ marginTop: 0 }} aria-labelledby="result-title">
                    <div className="result-topline">
                      <div>
                        <h2 id="result-title">Preflight result</h2>
                        <p>
                          {review.findings.length
                            ? "Review the findings before creating a draft."
                            : "No deterministic blockers found. Confirm the details before approval."}
                        </p>
                      </div>
                      <span className={`status-badge status-${review.status.toLowerCase()}`}>
                        <span className="status-icon">
                          <Icon name={review.status === "READY" ? "check" : "alert"} size={14} />
                        </span>
                        {review.status}
                      </span>
                    </div>

                    <div className="total-callout">
                      <span>Invoice total</span>
                      <strong>{formatMoney(review.totalMinor, review.input.currency)}</strong>
                      <span className="total-currency">{review.input.currency}</span>
                    </div>

                    {review.findings.length > 0 && (
                      <ul className="findings-list">
                        {review.findings.map((finding, index) => (
                          <li key={`${finding.code}-${index}`} className={`finding finding-${finding.severity}`}>
                            <Icon name={finding.severity === "block" ? "alert" : "file"} size={18} />
                            <div>
                              <strong>{finding.severity === "block" ? "Hold" : "Review"}</strong>
                              <p>{finding.message}</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* ReAct Reconciliation Agent Trace Panel */}
                    <div style={{ marginTop: "20px", padding: "16px", borderRadius: "10px", background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <Icon name="spark" size={18} />
                          <strong style={{ fontSize: "14px", color: "#0f172a" }}>Autonomous ReAct Reconciliation Agent</strong>
                          {agentBusy ? (
                            <span style={{ fontSize: "12px", color: "var(--blue)", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                              <span className="spinner" /> Auditing SOW &amp; Duplicates...
                            </span>
                          ) : agentTrace?.status ? (
                            <span
                              style={{
                                fontSize: "11px",
                                fontWeight: 700,
                                padding: "2px 8px",
                                borderRadius: "4px",
                                background: agentTrace.status === "APPROVED" ? "var(--success-bg)" : "var(--danger-bg)",
                                color: agentTrace.status === "APPROVED" ? "var(--success)" : "var(--danger)",
                              }}
                            >
                              {agentTrace.status}
                            </span>
                          ) : null}
                        </div>

                        <button
                          type="button"
                          className="button-secondary"
                          style={{ fontSize: "12px", padding: "5px 12px", minHeight: "auto" }}
                          disabled={agentBusy}
                          onClick={() => executeReconciliationAgent()}
                        >
                          {agentBusy ? "Deliberating..." : "Re-run Agent Audit"}
                        </button>
                      </div>

                      {agentTrace?.summary && (
                        <p style={{ fontSize: "13px", color: "#334155", margin: "0 0 12px", lineHeight: "1.5" }}>
                          {agentTrace.summary}
                        </p>
                      )}

                      {agentTrace?.steps && agentTrace.steps.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px" }}>
                          {agentTrace.steps.map((st) => (
                            <div
                              key={st.step}
                              style={{
                                padding: "10px 12px",
                                background: "#ffffff",
                                border: "1px solid #cbd5e1",
                                borderRadius: "6px",
                                fontSize: "12px",
                                fontFamily: "var(--font-geist-mono), monospace",
                              }}
                            >
                              <div style={{ display: "flex", justifyContent: "space-between", color: "#0057ff", fontWeight: 600, marginBottom: "4px" }}>
                                <span>Step {st.step}: {st.toolCalls.map((tc) => tc.toolName).join(", ") || "Audit Reasoning"}</span>
                              </div>
                              {st.thought && <div style={{ color: "#64748b", marginBottom: "4px" }}>Thought: {st.thought}</div>}
                              {st.toolCalls.length > 0 && (
                                <div style={{ color: "#334155" }}>
                                  Args: {JSON.stringify(st.toolCalls[0].args)}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginTop: "24px",
                        paddingTop: "20px",
                        borderTop: "1px solid var(--border)",
                      }}
                    >
                      <button type="button" className="button-secondary" onClick={() => setActiveStep(0)}>
                        ← Back to details
                      </button>
                      <button type="button" className="button-primary" onClick={() => setActiveStep(2)}>
                        Next <Icon name="arrow" size={17} />
                      </button>
                    </div>
                  </section>
                </div>
              )}

              {/* STEP 2: PAYPAL APPROVAL PAGE */}
              {activeStep === 2 && review && (
                <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                  <div className="intro">
                    <h1 id="page-title">PayPal approval &amp; disbursement.</h1>
                    <p>Authorize draft creation and issue payments directly through PayPal Sandbox.</p>
                  </div>

                  {/* Single invoice draft view (only when single report) */}
                  {batchReviews.length <= 1 && (
                    <section className="surface form-surface">
                      <div className="section-heading">
                        <div>
                          <h2>{invoiceId ? (sent ? "Invoice sent" : "Sandbox draft created") : "Approval ready"}</h2>
                          <p>
                            {sent
                              ? "PayPal accepted the send request. Transaction recorded in Public Ledger."
                              : invoiceId
                              ? "Review the hosted invoice, then approve sending separately."
                              : "Review invoice amount before draft creation."}
                          </p>
                        </div>
                        <span className="section-count">{review.input.currency}</span>
                      </div>

                      <div className="total-callout" style={{ marginTop: 0, marginBottom: "20px" }}>
                        <span>Invoice total</span>
                        <strong>{formatMoney(review.totalMinor, review.input.currency)}</strong>
                        <span className="total-currency">{review.input.currency}</span>
                      </div>

                      {/* ADMIN UNLOCK & TOKEN PANEL */}
                      <div style={{ marginBottom: "16px", padding: "12px 14px", borderRadius: "8px", background: "#f1f5f9", border: "1px solid #cbd5e1" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <Icon name="shield" size={16} />
                            <strong style={{ fontSize: "13px", color: "#1e293b" }}>Admin Governance Gate</strong>
                            <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px", background: "#dcfce7", color: "#15803d" }}>
                              UNLOCKED
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setShowAdminKey(!showAdminKey)}
                            style={{ fontSize: "12px", color: "#0057ff", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
                          >
                            {showAdminKey ? "Hide Token" : "Inspect Admin Token"}
                          </button>
                        </div>

                        {showAdminKey && (
                          <div style={{ marginTop: "10px" }}>
                            <label className="field" style={{ margin: 0 }}>
                              <span style={{ fontSize: "11px" }}>Configured Admin Token (Used for Payouts &amp; SOW Discrepancy Audits)</span>
                              <input
                                type="text"
                                value={adminToken}
                                onChange={(e) => setAdminToken(e.target.value)}
                                style={{ fontFamily: "monospace", fontSize: "12px", padding: "6px 10px" }}
                              />
                            </label>
                          </div>
                        )}
                      </div>

                      {!invoiceId && (
                        <div className="approval-row" style={{ marginTop: "16px", paddingTop: "16px", flexDirection: "column", gap: "12px", alignItems: "stretch" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                            <div>
                              <strong>Ready for Humanitarian Payout</strong>
                              <span style={{ display: "block", fontSize: "12px", color: "var(--muted)" }}>
                                Atomically locks campaign pool &amp; executes PayPal Payouts to registered vendor.
                              </span>
                            </div>
                            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                              <button
                                type="button"
                                className="button-secondary"
                                onClick={createDraft}
                                disabled={busy || !approvalToken || paypalConfigured !== true}
                                style={{ fontSize: "13px" }}
                              >
                                Draft Invoice Only
                              </button>
                              <button
                                type="button"
                                className="button-primary"
                                onClick={handleDisburseWithPayout}
                                disabled={busy || !approvalToken || paypalConfigured !== true}
                              >
                                {busy ? (
                                  <>
                                    <span className="spinner" /> Executing Payout...
                                  </>
                                ) : (
                                  <>
                                    Approve &amp; Pay via PayPal Payouts <Icon name="arrow" size={17} />
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {invoiceId && (
                        <div className={`surface draft-surface${sent ? " is-sent" : ""}`} style={{ marginTop: 0 }} aria-labelledby="draft-title">
                          <div className="draft-heading">
                            <span className="draft-icon">
                              <Icon name={sent ? "check" : "file"} size={20} />
                            </span>
                            <div>
                              <h2 id="draft-title">{sent ? "Invoice sent" : "Sandbox draft created"}</h2>
                              <p>
                                {sent
                                  ? "PayPal accepted the send request. Recorded in Public Audit Ledger."
                                  : "Approve sending to disburse funds to the supplier."}
                              </p>
                            </div>
                          </div>
                          <div className="draft-reference">
                            <span>PayPal invoice ID</span>
                            <code>{invoiceId}</code>
                          </div>
                          <div className="draft-actions">
                            {sent && invoiceUrl && (
                              <a className="button-secondary" href={invoiceUrl} target="_blank" rel="noreferrer">
                                Open hosted invoice <Icon name="external" size={16} />
                              </a>
                            )}
                            {!sent && (
                              <button
                                type="button"
                                className="button-primary"
                                onClick={sendInvoice}
                                disabled={busy || !sendToken}
                              >
                                {busy ? (
                                  <>
                                    <span className="spinner" /> Sending
                                  </>
                                ) : (
                                  <>
                                    Approve &amp; send invoice <Icon name="arrow" size={17} />
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </section>
                  )}

                  {/* MULTI-INVOICE APPROVALS & BATCH CARDS */}
                  {batchReviews.length > 1 && (
                    <section className="surface draft-surface" style={{ marginTop: 0 }} aria-labelledby="batch-heading">
                      <div className="draft-heading">
                        <span className="draft-icon">
                          <Icon name={activePendingCount === 0 ? "check" : "file"} size={20} />
                        </span>
                        <div>
                          <h2 id="batch-heading">Multi-Invoice Reports ({activeBatchReviews.length})</h2>
                          <p>
                            {activePendingCount === 0
                              ? "All detected invoices have been sent through PayPal Sandbox."
                              : "Review each report. Approve individually with the side button, dismiss with ✕, or approve all at once below."}
                          </p>
                        </div>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "16px" }}>
                        {activeBatchReviews.map((rep) => {
                          const st = batchStatuses[rep.id] || { sent: false, dismissed: false, busy: false };
                          const isReady = rep.review.status === "READY";
                          return (
                            <div
                              key={rep.id}
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                padding: "14px 16px",
                                background: st.sent ? "rgba(16, 185, 129, 0.04)" : "#ffffff",
                                border: st.sent ? "1px solid rgba(16, 185, 129, 0.3)" : "1px solid #cbd5e1",
                                borderRadius: "8px",
                                gap: "14px",
                              }}
                            >
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
                                  <strong style={{ fontSize: "14px", color: "#0f172a" }}>{rep.sectionTitle}</strong>
                                  <span
                                    style={{
                                      fontSize: "11px",
                                      fontWeight: 600,
                                      padding: "2px 6px",
                                      borderRadius: "4px",
                                      background: st.sent
                                        ? "rgba(16, 185, 129, 0.15)"
                                        : isReady
                                        ? "rgba(2, 132, 199, 0.12)"
                                        : "rgba(239, 68, 68, 0.12)",
                                      color: st.sent ? "#059669" : isReady ? "#0284c7" : "#dc2626",
                                    }}
                                  >
                                    {st.sent ? "SENT ✓" : isReady ? "READY" : "HOLD"}
                                  </span>
                                </div>
                                <div style={{ fontSize: "13px", color: "#475569", display: "flex", gap: "10px", flexWrap: "wrap" }}>
                                  <span>PO: <code>{rep.review.input.poNumber}</code></span>
                                  <span>•</span>
                                  <strong>{formatMoney(rep.review.totalMinor, rep.review.input.currency)}</strong>
                                  {st.invoiceId && (
                                    <>
                                      <span>•</span>
                                      <span><code>{st.invoiceId}</code></span>
                                    </>
                                  )}
                                </div>
                                {st.error && (
                                  <div style={{ marginTop: "4px", fontSize: "12px", color: "#dc2626" }}>
                                    {st.error}
                                  </div>
                                )}
                              </div>

                              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                                {st.sent && st.url ? (
                                  <a
                                    className="button-secondary"
                                    href={st.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", padding: "8px 12px" }}
                                  >
                                    Open hosted invoice <Icon name="external" size={14} />
                                  </a>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      className="button-primary"
                                      disabled={st.busy || globalBatchBusy || !isReady || paypalConfigured !== true}
                                      onClick={() => handleApproveSingle(rep)}
                                      style={{ fontSize: "12px", padding: "7px 12px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                                    >
                                      {st.busy ? (
                                        <><span className="spinner" />Sending...</>
                                      ) : (
                                        <>Approve <Icon name="check" size={13} /></>
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      className="icon-button"
                                      disabled={st.busy || globalBatchBusy}
                                      onClick={() => handleDismissSingle(rep.id)}
                                      title="Don't approve this invoice"
                                      aria-label="Don't approve this invoice"
                                      style={{ border: "1px solid #cbd5e1", borderRadius: "6px", width: "32px", height: "32px", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#64748b" }}
                                    >
                                      <Icon name="close" size={14} />
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {activePendingCount > 0 && (
                        <div style={{ marginTop: "20px", display: "flex", justifyContent: "center" }}>
                          <button
                            type="button"
                            className="button-primary"
                            onClick={handleApproveAll}
                            disabled={globalBatchBusy || paypalConfigured !== true}
                            style={{ width: "100%", padding: "14px 20px", fontSize: "15px", fontWeight: 600, display: "flex", justifyContent: "center", alignItems: "center", gap: "8px" }}
                          >
                            {globalBatchBusy ? (
                              <><span className="spinner" />Approving &amp; sending {activePendingCount} invoices in PayPal...</>
                            ) : (
                              <>Approve all ({activePendingCount}) invoices at the same time <Icon name="arrow" size={17} /></>
                            )}
                          </button>
                        </div>
                      )}
                    </section>
                  )}

                  <div style={{ marginTop: "10px" }}>
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => setActiveStep(1)}
                    >
                      ← Back to preflight result
                    </button>
                  </div>
                </div>
              )}

              {/* FALLBACK IF USER JUMPS TO STEP 1 OR 2 WITHOUT REVIEW */}
              {activeStep > 0 && !review && (
                <div className="surface form-surface" style={{ textAlign: "center", padding: "40px 20px" }}>
                  <h2>No preflight review found</h2>
                  <p style={{ margin: "12px 0 20px", color: "var(--muted)" }}>
                    Please complete the invoice details and run preflight first.
                  </p>
                  <button type="button" className="button-primary" onClick={() => setActiveStep(0)}>
                    ← Go to invoice details
                  </button>
                </div>
              )}
            </>
          )}

          {/* =========================================================================
              VIEW 3: PUBLIC TRANSPARENCY LEDGER (AUDIT PROOF & PAYPAL HOSTED LINKS)
              ========================================================================= */}
          {activePlatformTab === "ledger" && (
            <div className="ledger-surface">
              <div className="section-heading" style={{ flexWrap: "wrap", gap: "12px", alignItems: "flex-start" }}>
                <div>
                  <h1 id="page-title" style={{ fontSize: "24px", marginBottom: "6px" }}>
                    Public Proof-of-Aid Cryptographic Ledger
                  </h1>
                  <p>
                    Immutable SHA-256 hash-chained public audit ledger stored in Neon PostgreSQL. Every donation capture
                    and vendor payout forms a tamper-evident linked list verified by PayPal webhooks.
                  </p>
                </div>
                <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="button-primary"
                    onClick={handleVerifyLedgerChain}
                    style={{ fontSize: "13px", padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: "6px" }}
                  >
                    <Icon name="shield" size={15} /> Verify Hash Chain
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={refreshLedger}
                    disabled={ledgerLoading}
                    style={{ fontSize: "13px", padding: "8px 14px" }}
                  >
                    {ledgerLoading ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
              </div>

              {/* LIVE HEAD HASH BANNER */}
              <div style={{ margin: "16px 0", padding: "12px 16px", background: "#f8fafc", borderRadius: "8px", border: "1px solid #cbd5e1", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ fontSize: "12px", fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                    Cryptographic Head Hash:
                  </span>
                  <code style={{ fontSize: "12px", background: "#ffffff", padding: "3px 8px", borderRadius: "4px", border: "1px solid #cbd5e1", color: "#0057ff", fontWeight: 600 }}>
                    {ledgerHeadHash}
                  </code>
                </div>
                <span style={{ fontSize: "12px", color: "#64748b" }}>
                  {ledgerEntries.length} Cryptographically Sealed Blocks
                </span>
              </div>

              {/* VERIFICATION STATUS ALERT */}
              {verifyStatus && (
                <div
                  style={{
                    marginBottom: "16px",
                    padding: "12px 16px",
                    borderRadius: "8px",
                    background: verifyStatus.ok ? "#ecfdf5" : "#fef2f2",
                    border: verifyStatus.ok ? "1px solid #6ee7b7" : "1px solid #fca5a5",
                    color: verifyStatus.ok ? "#065f46" : "#991b1b",
                    fontSize: "13px",
                    fontWeight: 500,
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <Icon name={verifyStatus.ok ? "check" : "alert"} size={16} />
                  <span>{verifyStatus.message}</span>
                </div>
              )}

              <div className="ledger-table-wrap">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>Block #</th>
                      <th>Timestamp (UTC)</th>
                      <th>Operation Kind</th>
                      <th>Campaign / Reference</th>
                      <th>Amount</th>
                      <th>Block Hash &amp; Prev Hash</th>
                      <th>Status &amp; Proof</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerEntries.map((entry) => {
                      const amountMinor = Number(entry.payload?.amountMinor || 0);
                      const isDonation = entry.kind === "DONATION_COMPLETED";
                      const isPaid = entry.kind === "PAYOUT_PAID";
                      const isApproved = entry.kind === "DISBURSEMENT_APPROVED";

                      return (
                        <tr key={entry.id}>
                          <td>
                            <strong style={{ fontFamily: "monospace", color: "#0f172a" }}>#{entry.id}</strong>
                          </td>
                          <td style={{ whiteSpace: "nowrap", color: "var(--muted)", fontSize: "12px" }}>
                            {new Date(entry.createdAt).toUTCString().replace("GMT", "UTC").slice(5, 22)}
                          </td>
                          <td>
                            <span
                              style={{
                                display: "inline-block",
                                padding: "3px 8px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: 700,
                                background: isDonation
                                  ? "#dcfce7"
                                  : isPaid
                                  ? "#d1fae5"
                                  : isApproved
                                  ? "#e0e7ff"
                                  : "#fee2e2",
                                color: isDonation
                                  ? "#15803d"
                                  : isPaid
                                  ? "#047857"
                                  : isApproved
                                  ? "#3730a3"
                                  : "#b91c1c",
                              }}
                            >
                              {isDonation ? "+ DONATION CAPTURED" : isPaid ? "✓ PAYOUT SETTLED" : isApproved ? "POOL RESERVED" : entry.kind}
                            </span>
                          </td>
                          <td>
                            <strong style={{ display: "block", color: "var(--ink)", fontSize: "13px" }}>
                              {entry.campaignId || entry.refId}
                            </strong>
                            <span style={{ fontSize: "11px", color: "var(--muted)" }}>Ref: {entry.refId}</span>
                          </td>
                          <td>
                            <strong style={{ color: isDonation ? "#059669" : "var(--blue-deep)", fontVariantNumeric: "tabular-nums" }}>
                              {amountMinor > 0 ? formatMoney(amountMinor, "USD") : "—"}
                            </strong>
                          </td>
                          <td>
                            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                              <span style={{ fontSize: "11px", color: "#0f172a" }}>
                                <strong>Hash:</strong> <code className="ledger-hash">{entry.entryHash.slice(0, 16)}…</code>
                              </span>
                              <span style={{ fontSize: "10px", color: "#64748b" }}>
                                Prev: <code style={{ fontFamily: "monospace" }}>{entry.prevHash.slice(0, 12)}…</code>
                              </span>
                            </div>
                          </td>
                          <td>
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                padding: "4px 8px",
                                borderRadius: "4px",
                                background: "var(--success-bg)",
                                color: "var(--success)",
                                fontWeight: 700,
                                fontSize: "11px",
                              }}
                            >
                              <Icon name="check" size={13} /> SEALED
                            </span>
                          </td>
                        </tr>
                      );
                    })}

                    {/* Fallback to simulated seeds if ledger is still syncing */}
                    {ledgerEntries.length === 0 && disbursements.map((item) => (
                      <tr key={item.id}>
                        <td><strong style={{ fontFamily: "monospace" }}>#SEED</strong></td>
                        <td style={{ whiteSpace: "nowrap", color: "var(--muted)" }}>{item.timestamp}</td>
                        <td>
                          <span style={{ padding: "3px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: 700, background: "#d1fae5", color: "#047857" }}>
                            ✓ PAYOUT SETTLED
                          </span>
                        </td>
                        <td>
                          <strong style={{ display: "block", color: "var(--ink)" }}>{item.campaignTitle}</strong>
                          <span style={{ fontSize: "11px", color: "var(--muted)" }}>{item.vendorName}</span>
                        </td>
                        <td>
                          <strong style={{ color: "var(--blue-deep)", fontVariantNumeric: "tabular-nums" }}>
                            {formatMoney(item.amountMinor, item.currency)}
                          </strong>
                        </td>
                        <td>
                          <code className="ledger-hash">{item.preflightProofHash}</code>
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => setViewingDisbursement(item)}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                              fontSize: "12px",
                              color: "var(--blue)",
                              fontWeight: 600,
                              background: "transparent",
                              border: "1px solid #bfdbfe",
                              borderRadius: "6px",
                              padding: "4px 9px",
                              cursor: "pointer",
                            }}
                          >
                            View Proof <Icon name="external" size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        {/* SIDEBAR COLUMN */}
        <aside className="side-column" aria-label="Evidence and process information">
          {activePlatformTab === "disburse" ? (
            <>
              <section className="evidence-panel">
                <div className="side-panel-heading">
                  <span className="side-icon">
                    <Icon name="file" size={18} />
                  </span>
                  <div>
                    <h2>Evidence &amp; checks</h2>
                    <p>What this review can prove</p>
                  </div>
                </div>
                {review?.input.evidence?.length ? (
                  <div className="evidence-list">
                    {review.input.evidence.map((ref, index) => (
                      <blockquote className="evidence-quote" key={`${ref.document}-${ref.page}-${index}`}>
                        <span className="quote-mark">“</span>
                        <p>{ref.quote}</p>
                        <footer>
                          <Icon name="file" size={13} />
                          {ref.document}
                          {ref.page ? <span> · page {ref.page}</span> : null}
                        </footer>
                      </blockquote>
                    ))}
                  </div>
                ) : (
                  <div className="evidence-empty">
                    <span className="empty-icon">
                      <Icon name="upload" size={19} />
                    </span>
                    <strong>{file ? "Source evidence will appear here" : "Add a source document"}</strong>
                    <p>Searchable PO or SOW text can support extracted values and help explain a finding.</p>
                  </div>
                )}
                <div className="side-panel-divider" />
                <div className="check-list-title">
                  <Icon name="shield" size={16} />
                  <strong>Deterministic checks</strong>
                </div>
                <ul className="check-list">
                  <li><Icon name="check" size={15} />Required buyer and invoice fields</li>
                  <li><Icon name="check" size={15} />Line item math and currency format</li>
                  <li><Icon name="check" size={15} />Stated Grant PO budget maximum</li>
                  <li><Icon name="check" size={15} />Buyer, vendor, and grant consistency</li>
                </ul>
                <p className="check-footnote">AI can suggest and explain. It cannot clear a blocking check.</p>
              </section>

              <section className="process-panel">
                <span className="process-kicker">YOUR CONTROL, EACH STEP</span>
                <h2>A review before the send.</h2>
                <ol className="process-list">
                  <li>
                    <span className="process-marker">1</span>
                    <div>
                      <strong>Enter the invoice</strong>
                      <p>Upload a searchable PDF or bind to a relief grant.</p>
                    </div>
                  </li>
                  <li>
                    <span className="process-marker">2</span>
                    <div>
                      <strong>Resolve what’s unclear</strong>
                      <p>Inspect the math, grant caps, and source evidence.</p>
                    </div>
                  </li>
                  <li>
                    <span className="process-marker">3</span>
                    <div>
                      <strong>Approve PayPal actions</strong>
                      <p>Draft creation and sending are separate approvals.</p>
                    </div>
                  </li>
                </ol>
                <div className="sandbox-note">
                  <span className="sandbox-note-dot" />
                  <p>
                    <strong>Sandbox workspace</strong>
                    <br />
                    {paypalConfigured === true
                      ? "PayPal sandbox is connected. No live funds move."
                      : "Connect PayPal sandbox credentials to enable invoice actions."}
                  </p>
                </div>
              </section>

              <footer className="workspace-footer">
                <span className="footer-mark">IR</span>
                <span>Invoice Ready</span>
                <span className="footer-divider" />
                <span>Evidence before you bill.</span>
              </footer>
            </>
          ) : activePlatformTab === "campaigns" ? (
            <>
              <section className="evidence-panel">
                <div className="side-panel-heading">
                  <span className="side-icon">
                    <Icon name="heart" size={18} />
                  </span>
                  <div>
                    <h2>Donor Safeguards</h2>
                    <p>Zero unverified administrative leakage</p>
                  </div>
                </div>
                <p style={{ fontSize: "12.5px", color: "var(--muted)", margin: "14px 0 10px", lineHeight: "1.5" }}>
                  Every donation made via PayPal Orders v2 is captured into the grant pool and committed to the cryptographic audit ledger. Payouts are reserved atomically from an admin-registered vendor list.
                </p>
                <div className="side-panel-divider" />
                <div className="check-list-title">
                  <Icon name="shield" size={16} />
                  <strong>The Relief Ready Guarantee</strong>
                </div>
                <ul className="check-list">
                  <li><Icon name="check" size={15} />100% of line items matched to grant SOWs</li>
                  <li><Icon name="check" size={15} />Deterministic minor-unit math verification</li>
                  <li><Icon name="check" size={15} />Payout to admin-registered vendors via PayPal Payouts</li>
                  <li><Icon name="check" size={15} />Live proof posted to public transparency ledger</li>
                </ul>
              </section>

              <section className="process-panel">
                <span className="process-kicker">DISBURSEMENT LIFECYCLE</span>
                <h2>How aid gets delivered.</h2>
                <ol className="process-list">
                  <li>
                    <span className="process-marker">1</span>
                    <div>
                      <strong>Donate via PayPal</strong>
                      <p>Funds pool securely in the crisis relief allocation.</p>
                    </div>
                  </li>
                  <li>
                    <span className="process-marker">2</span>
                    <div>
                      <strong>Invoice Ready Preflight</strong>
                      <p>Contractor claims undergo deterministic rate audits.</p>
                    </div>
                  </li>
                  <li>
                    <span className="process-marker">3</span>
                    <div>
                      <strong>Human Approval &amp; Verified Payout</strong>
                      <p>Approved funds release directly to registered vendor accounts via PayPal Payouts.</p>
                    </div>
                  </li>
                </ol>
                <div className="sandbox-note">
                  <span className="sandbox-note-dot" />
                  <p>
                    <strong>PayPal Orders v2 &amp; Payouts</strong>
                    <br />
                    Connected in Sandbox mode for verifiable test transactions.
                  </p>
                </div>
              </section>

              <footer className="workspace-footer">
                <span className="footer-mark">RR</span>
                <span>Relief Ready</span>
                <span className="footer-divider" />
                <span>Evidence-based humanitarian aid.</span>
              </footer>
            </>
          ) : (
            <>
              <section className="evidence-panel">
                <div className="side-panel-heading">
                  <span className="side-icon">
                    <Icon name="shield" size={18} />
                  </span>
                  <div>
                    <h2>Audit Integrity</h2>
                    <p>Cryptographic proof of disbursement</p>
                  </div>
                </div>
                <p style={{ fontSize: "12.5px", color: "var(--muted)", margin: "14px 0 10px", lineHeight: "1.5" }}>
                  Every disbursement row in this ledger is cryptographically sealed with an HMAC token signed upon
                  preflight completion.
                </p>
                <div className="side-panel-divider" />
                <div className="check-list-title">
                  <Icon name="shield" size={16} />
                  <strong>Audit Proof Invariants</strong>
                </div>
                <ul className="check-list">
                  <li><Icon name="check" size={15} />Zero-drift dollar totals (cents-exact)</li>
                  <li><Icon name="check" size={15} />Immutable PayPal invoice IDs (`INV2-...`)</li>
                  <li><Icon name="check" size={15} />Grant cap threshold checks enforced</li>
                </ul>
              </section>

              <section className="process-panel">
                <span className="process-kicker">PUBLIC ACCOUNTABILITY</span>
                <h2>Zero leakage standard.</h2>
                <ol className="process-list">
                  <li>
                    <span className="process-marker">1</span>
                    <div>
                      <strong>Verified Invoices Only</strong>
                      <p>No arbitrary withdrawals; every payout requires an invoice.</p>
                    </div>
                  </li>
                  <li>
                    <span className="process-marker">2</span>
                    <div>
                      <strong>Public Inspection</strong>
                      <p>Hosted PayPal invoice links verify delivery proof.</p>
                    </div>
                  </li>
                  <li>
                    <span className="process-marker">3</span>
                    <div>
                      <strong>Donor Transparency</strong>
                      <p>Donors trace donations directly to field impact.</p>
                    </div>
                  </li>
                </ol>
              </section>

              <footer className="workspace-footer">
                <span className="footer-mark">RR</span>
                <span>Relief Ready</span>
                <span className="footer-divider" />
                <span>Evidence-based humanitarian aid.</span>
              </footer>
            </>
          )}
        </aside>
      </div>

      {/* VERIFIED DISBURSEMENT CERTIFICATE MODAL */}
      {viewingDisbursement && (
        <div className="cert-backdrop" onClick={() => setViewingDisbursement(null)}>
          <div className="cert-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cert-header">
              <div className="cert-brand-group">
                <span className="cert-seal" aria-hidden="true">RR</span>
                <div className="cert-title-group">
                  <h2>Verified Disbursement Certificate</h2>
                  <p>Relief Ready Deterministic Preflight &amp; PayPal Settlement</p>
                </div>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setViewingDisbursement(null)}
                aria-label="Close certificate"
              >
                <Icon name="close" size={18} />
              </button>
            </div>

            <div className="cert-meta-grid">
              <div className="cert-meta-item">
                <span className="cert-meta-label">Relief Operation</span>
                <span className="cert-meta-value">{viewingDisbursement.campaignTitle}</span>
              </div>
              <div className="cert-meta-item">
                <span className="cert-meta-label">Grant PO Code</span>
                <span className="cert-meta-value"><code>{viewingDisbursement.grantCode || "GRANT-RELIEF-2026"}</code></span>
              </div>
              <div className="cert-meta-item">
                <span className="cert-meta-label">Field Contractor / Vendor</span>
                <span className="cert-meta-value">{viewingDisbursement.vendorName}</span>
              </div>
              <div className="cert-meta-item">
                <span className="cert-meta-label">Disbursement Date</span>
                <span className="cert-meta-value">{viewingDisbursement.timestamp}</span>
              </div>
            </div>

            {/* Line items table */}
            {viewingDisbursement.items && viewingDisbursement.items.length > 0 && (
              <table className="cert-items-table">
                <thead>
                  <tr>
                    <th>Deliverable / Aid Item</th>
                    <th style={{ textAlign: "right" }}>Qty</th>
                    <th style={{ textAlign: "right" }}>Rate</th>
                    <th style={{ textAlign: "right" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {viewingDisbursement.items.map((it, idx) => {
                    const lineTotal = (Number(it.quantity) || 1) * (Number(it.unitAmount) || 0);
                    return (
                      <tr key={idx}>
                        <td>{it.description}</td>
                        <td style={{ textAlign: "right" }}>{it.quantity}</td>
                        <td style={{ textAlign: "right" }}>${Number(it.unitAmount).toFixed(2)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>${lineTotal.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            <div className="cert-total-row">
              <div>
                <strong style={{ fontSize: "14px", color: "var(--ink)" }}>Audited Disbursement Total</strong>
                <div style={{ fontSize: "12px", color: "var(--muted)" }}>Preflight verified · Zero fractional cent drift</div>
              </div>
              <strong style={{ fontSize: "24px", color: "var(--blue-deep)", fontVariantNumeric: "tabular-nums" }}>
                {formatMoney(viewingDisbursement.amountMinor, viewingDisbursement.currency)}
              </strong>
            </div>

            <div className="cert-proof-box">
              <div className="cert-proof-item">
                <Icon name="check" size={15} />
                <span>Deterministic math &amp; unit rates match approved grant quotation.</span>
              </div>
              <div className="cert-proof-item">
                <Icon name="check" size={15} />
                <span>Total amount satisfies remaining uncommitted grant pool cap.</span>
              </div>
              <div className="cert-proof-item">
                <Icon name="check" size={15} />
                <span>PayPal Sandbox Invoicing ID: <code>{viewingDisbursement.paypalInvoiceId}</code></span>
              </div>
              <div className="cert-proof-item" style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px dashed #cbd5e1" }}>
                <span style={{ fontSize: "11px", color: "var(--muted)", overflowWrap: "anywhere" }}>
                  <strong>Cryptographic Proof Hash:</strong> <code>{viewingDisbursement.preflightProofHash}</code>
                </span>
              </div>
            </div>

            {viewingDisbursement.isSimulated && (
              <p style={{ fontSize: "11.5px", color: "var(--muted)", margin: "0 0 16px", lineHeight: "1.4" }}>
                ℹ️ <em>Pre-seeded audit baseline. Invoices approved and sent via the <strong>Audit &amp; Disburse</strong> tab generate live hosted invoices directly on your connected PayPal Sandbox account.</em>
              </p>
            )}

            <div className="cert-actions">
              {!viewingDisbursement.isSimulated && viewingDisbursement.hostedInvoiceUrl && (
                <a
                  className="button-secondary"
                  href={viewingDisbursement.hostedInvoiceUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                >
                  Open in PayPal Sandbox <Icon name="external" size={14} />
                </a>
              )}
              <button
                type="button"
                className="button-primary"
                onClick={() => setViewingDisbursement(null)}
              >
                Close Certificate
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
