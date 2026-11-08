"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { ReviewInput, ReviewResult, BatchReportReview } from "@/lib/types";

type IconName = "check" | "upload" | "file" | "alert" | "spark" | "plus" | "trash" | "arrow" | "shield" | "close";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  const paths: Record<IconName, React.ReactNode> = {
    check: <><path d="m5 12 4 4L19 6" /></>,
    upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M20 16.5v2A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-2"/></>,
    file: <><path d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9z"/><path d="M13 3v6h6M8 13h8m-8 4h8"/></>,
    alert: <><path d="M10.3 4.4 2.9 17.2A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.8L13.7 4.4a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 3h.01"/></>,
    spark: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    trash: <><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6"/></>,
    shield: <><path d="M12 3 20 6v5.5c0 4.7-3.4 7.8-8 9.5-4.6-1.7-8-4.8-8-9.5V6l8-3Z"/><path d="m8.5 12 2.2 2.2 4.8-4.8"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
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
    return new Intl.NumberFormat("en-US", { style: "currency", currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD" }).format(minor / 100);
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

  useEffect(() => {
    fetch("/api/status")
      .then((response) => response.json())
      .then((status: { paypalConfigured?: boolean }) => setPaypalConfigured(status.paypalConfigured === true))
      .catch(() => setPaypalConfigured(false));
  }, []);

  const step = sent || invoiceId ? 2 : review ? 1 : 0;
  const previewMinor = useMemo(() => data.items.reduce((sum, item) => {
    const amount = Number(item.unitAmount);
    const quantity = Number(item.quantity);
    return Number.isFinite(amount) && Number.isFinite(quantity) && amount > 0 && quantity > 0
      ? sum + Math.round(amount * 100) * Math.trunc(quantity)
      : sum;
  }, 0), [data.items]);

  function invalidateReview() {
    setReview(null);
    setReviewId("");
    setApprovalToken("");
    setSendToken("");
    setInvoiceId("");
    setInvoiceUrl("");
    setSent(false);
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
    setData((current) => ({ ...current, items: current.items.map((item, i) => i === index ? { ...item, [key]: value } : item) }));
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
          text: `Multi-invoice document detected: ${body.reviews.length} separate reports found. Review each report below and approve individually or all at once.`,
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
        setNotice(body.aiError
          ? { kind: "info", text: "PDF values were read from the text layer, but AI suggestions did not load. Check or complete the fields before approval." }
          : { kind: "success", text: body.aiUsed ? "Suggestions are ready. Check each value against the source before approval." : body.pdfParsed ? "Fields were read from the PDF text. Check every value against the source before approval." : "Preflight is complete. Review the findings and invoice details below." });
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

  // Single invoice draft creation (used when single report)
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

  // Single invoice send (used when single report)
  async function sendInvoice() {
    if (!invoiceId || !sendToken || !reviewId) return;
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
      setNotice({ kind: "success", text: "Invoice sent through PayPal sandbox." });
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
      // 1. Create draft
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

      // 2. Immediately send so hosted view is live
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

      setNotice({
        kind: "success",
        text: `${rep.sectionTitle} approved & sent. Hosted invoice is now live in PayPal Sandbox.`,
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

  // Multi-invoice: Dismiss a report
  function handleDismissSingle(reportId: string) {
    setBatchStatuses((prev) => ({
      ...prev,
      [reportId]: { ...(prev[reportId] || { sent: false, busy: false }), dismissed: true },
    }));
  }

  // Multi-invoice: Approve & Send all pending reports at the same time
  async function handleApproveAll() {
    const pending = batchReviews.filter((rep) => {
      const st = batchStatuses[rep.id];
      return !st?.dismissed && !st?.sent && rep.review.status === "READY";
    });
    if (!pending.length) return;

    setGlobalBatchBusy(true);
    setNotice({ kind: "info", text: `Approving and sending ${pending.length} invoices through PayPal sandbox...` });

    let sentCount = 0;
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
        if (!sendRes.ok) {
          throw new Error(sendBody.error || "Send failed");
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

        sentCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed";
        setBatchStatuses((prev) => ({
          ...prev,
          [rep.id]: { ...(prev[rep.id] || { sent: false, dismissed: false }), busy: false, error: msg },
        }));
      }
    }

    setGlobalBatchBusy(false);
    setNotice({
      kind: "success",
      text: `Batch complete: ${sentCount} invoice(s) sent through PayPal. All hosted invoice links are live.`,
    });
  }

  function addItem() {
    invalidateReview();
    setData((current) => ({ ...current, items: [...current.items, { description: "", quantity: "1", unitAmount: "" }] }));
  }

  function removeItem(index: number) {
    invalidateReview();
    setData((current) => ({ ...current, items: current.items.filter((_, i) => i !== index) }));
  }

  const activeBatchReviews = batchReviews.filter((rep) => !batchStatuses[rep.id]?.dismissed);
  const activePendingCount = activeBatchReviews.filter((rep) => !batchStatuses[rep.id]?.sent && rep.review.status === "READY").length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#main" aria-label="Invoice Ready home">
            <span className="brand-mark" aria-hidden="true">IR</span>
            <span className="brand-name">Invoice Ready</span>
          </a>
          <div className="topbar-note"><Icon name="shield" size={16} /><span>Preflight verification for PayPal Invoicing</span></div>
          <span className="sandbox-badge"><span className="sandbox-dot" />{paypalConfigured === true ? "SANDBOX CONNECTED" : "SANDBOX"}</span>
        </div>
      </header>

      <nav className="workflow-rail" aria-label="Invoice review progress">
        <ol className="workflow-inner">
          {["Invoice details", "Preflight", "PayPal approval"].map((label, index) => {
            const isCompleted = (index === 0 && review !== null) || (index === 1 && (sent || Boolean(invoiceId) || Object.values(batchStatuses).some((s) => s.sent)));
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
                <span className="step-marker">{isCompleted ? <Icon name="check" size={14} /> : <span className="step-dot" />}</span>
                <span>{label}</span>
                {index < 2 && <span className="step-connector" aria-hidden="true" />}
              </li>
            );
          })}
        </ol>
      </nav>

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
          {/* STEP 0: INVOICE DETAILS FORM */}
          {activeStep === 0 && (
            <>
              <div className="intro">
                <h1 id="page-title">Make every invoice add up.</h1>
                <p>Check your invoice against the purchase order, resolve blockers, and send through PayPal only after you approve.</p>
              </div>

              <form className="surface form-surface" onSubmit={runReview}>
                <div className="section-heading">
                  <div>
                    <h2>Invoice details</h2>
                    <p>Enter the bill you plan to send. Add a searchable PO or statement of work for source checks.</p>
                  </div>
                  <span className="section-count">Vendor · Buyer · Terms</span>
                </div>

                <div className={`upload-zone${file ? " has-file" : ""}`}>
                  <label className="upload-hit-area" htmlFor="po-file">
                    <span className="upload-icon"><Icon name={file ? "file" : "upload"} size={21} /></span>
                    <span className="upload-copy">
                      <strong>{file ? file.name : "Add a purchase order or statement of work"}</strong>
                      <span>{file ? `${file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / 1024 / 1024).toFixed(2)} MB`} · Searchable PDF` : "Drop a searchable PDF here, or browse · up to 8 MB"}</span>
                    </span>
                    <input id="po-file" className="visually-hidden" type="file" accept="application/pdf,.pdf" onChange={(event) => { invalidateReview(); setFile(event.target.files?.[0] || null); }} />
                  </label>
                  {file && <button type="button" className="icon-button file-remove" aria-label="Remove uploaded file" onClick={() => { invalidateReview(); setFile(null); }}><Icon name="close" size={16} /></button>}
                </div>
                <p className="privacy-note"><Icon name="shield" size={14} />The original PDF is processed for this review and is not retained.</p>

                {batchReviews.length > 1 && (
                  <div style={{ margin: "16px 0", padding: "14px 16px", background: "var(--canvas)", borderRadius: "10px", border: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                      <strong style={{ fontSize: "14px", color: "var(--ink)" }}>Multi-Invoice Document: Found {batchReviews.length} Reports</strong>
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
                            <span style={{ fontSize: "12px", opacity: isSelected ? 0.9 : 0.7 }}>({formatMoney(rep.review.totalMinor, rep.review.input.currency)})</span>
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
                    <label className="field"><span>Your business</span><input autoComplete="organization" value={data.vendorName} onChange={(event) => updateField("vendorName", event.target.value)} placeholder="Northstar Studio" /></label>
                    <label className="field"><span>Buyer business</span><input value={data.buyerName} onChange={(event) => updateField("buyerName", event.target.value)} placeholder="Buyer company name" /></label>
                    <label className="field field-wide"><span>Buyer email</span><input type="email" autoComplete="email" value={data.buyerEmail} onChange={(event) => updateField("buyerEmail", event.target.value)} placeholder="accounts@buyer.com" /></label>
                  </div>
                </fieldset>

                <fieldset className="field-group terms-group">
                  <legend>Purchase order terms</legend>
                  <div className="field-grid field-grid-terms">
                    <label className="field"><span>PO number</span><input value={data.poNumber} onChange={(event) => updateField("poNumber", event.target.value)} placeholder="PO-1042" /></label>
                    <label className="field"><span>Invoice currency</span><select value={data.currency} onChange={(event) => updateField("currency", event.target.value)}><option value="USD">USD · US dollar</option><option value="EUR">EUR · Euro</option><option value="GBP">GBP · Pound sterling</option><option value="CAD">CAD · Canadian dollar</option><option value="AUD">AUD · Australian dollar</option><option value="INR">INR · Indian rupee</option></select></label>
                    <label className="field"><span>PO maximum <em>Optional</em></span><div className="input-prefix"><span>{data.currency || "USD"}</span><input inputMode="decimal" value={data.poCap || ""} onChange={(event) => updateField("poCap", event.target.value)} placeholder="0.00" aria-label="PO maximum amount" /></div></label>
                  </div>
                </fieldset>

                <fieldset className="field-group line-items-group">
                  <legend>What are you billing for?</legend>
                  <div className="line-items-head">
                    <span>Service or deliverable</span>
                    <span>Qty</span>
                    <span>Unit rate</span>
                    <span className="line-action-label">Remove</span>
                  </div>
                  <div className="line-items-list">
                    {data.items.map((item, index) => (
                      <div className="line-item" key={index}>
                        <label className="visually-hidden" htmlFor={`item-description-${index}`}>Service or deliverable, line {index + 1}</label>
                        <input
                          id={`item-description-${index}`}
                          value={item.description}
                          onChange={(event) => updateItem(index, "description", event.target.value)}
                          placeholder="e.g. Design sprint lead"
                        />
                        <label className="visually-hidden" htmlFor={`item-quantity-${index}`}>Quantity, line {index + 1}</label>
                        <input
                          id={`item-quantity-${index}`}
                          type="number"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          value={item.quantity}
                          onChange={(event) => updateItem(index, "quantity", event.target.value)}
                        />
                        <label className="visually-hidden" htmlFor={`item-rate-${index}`}>Unit rate, line {index + 1}</label>
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
                    <Icon name="plus" size={16} />Add a line item
                  </button>
                  <div className="invoice-total">
                    <span>Invoice total</span>
                    <strong>{formatMoney(previewMinor, data.currency)}</strong>
                  </div>
                </fieldset>

                {aiUsed && <div className="suggestion-banner"><span className="suggestion-icon"><Icon name="spark" size={17} /></span><p><strong>AI suggestions added.</strong> Verify the business names, PO number, and terms against the source evidence before approval.</p></div>}

                <div className="form-footer">
                  <span className="footer-note">You review each field before any PayPal action.</span>
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
                      {busy ? <><span className="spinner" />Checking invoice</> : <>Run preflight <Icon name="arrow" size={17} /></>}
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
                    <strong style={{ fontSize: "14px", color: "var(--ink)" }}>Multi-Invoice Reports ({batchReviews.length})</strong>
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
                          <span style={{ fontSize: "12px", opacity: isSelected ? 0.9 : 0.7 }}>({formatMoney(rep.review.totalMinor, rep.review.input.currency)})</span>
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
                  <div><h2 id="result-title">Preflight result</h2><p>{review.findings.length ? "Review the findings before creating a draft." : "No deterministic blockers found. Confirm the details before approval."}</p></div>
                  <span className={`status-badge status-${review.status.toLowerCase()}`}><span className="status-icon"><Icon name={review.status === "READY" ? "check" : "alert"} size={14} /></span>{review.status}</span>
                </div>

                <div className="total-callout"><span>Invoice total</span><strong>{formatMoney(review.totalMinor, review.input.currency)}</strong><span className="total-currency">{review.input.currency}</span></div>

                {review.findings.length > 0 && <ul className="findings-list">{review.findings.map((finding, index) => <li key={`${finding.code}-${index}`} className={`finding finding-${finding.severity}`}>
                  <Icon name={finding.severity === "block" ? "alert" : "file"} size={18} />
                  <div><strong>{finding.severity === "block" ? "Hold" : "Review"}</strong><p>{finding.message}</p></div>
                </li>)}</ul>}

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "24px", paddingTop: "20px", borderTop: "1px solid var(--border)" }}>
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
                <h1 id="page-title">PayPal approval.</h1>
                <p>Authorize draft creation and issue invoices directly through PayPal Sandbox.</p>
              </div>

              {/* Single invoice draft view (only when single report) */}
              {batchReviews.length <= 1 && (
                <section className="surface form-surface">
                  <div className="section-heading">
                    <div>
                      <h2>{invoiceId ? (sent ? "Invoice sent" : "Sandbox draft created") : "Approval ready"}</h2>
                      <p>{sent ? "PayPal accepted the send request." : invoiceId ? "Review the hosted invoice, then approve sending separately." : "Review invoice amount before draft creation."}</p>
                    </div>
                    <span className="section-count">{review.input.currency}</span>
                  </div>

                  <div className="total-callout" style={{ marginTop: 0, marginBottom: "20px" }}>
                    <span>Invoice total</span>
                    <strong>{formatMoney(review.totalMinor, review.input.currency)}</strong>
                    <span className="total-currency">{review.input.currency}</span>
                  </div>

                  {!invoiceId && (
                    <div className="approval-row" style={{ marginTop: "16px", paddingTop: "16px" }}>
                      <div>
                        <strong>Ready for your approval</strong>
                        <span>{paypalConfigured === true ? "Creating a draft does not send it." : paypalConfigured === false ? "Add PayPal sandbox credentials to enable invoice actions." : "Checking PayPal sandbox connection…"}</span>
                      </div>
                      <button type="button" className="button-primary" onClick={createDraft} disabled={busy || !approvalToken || paypalConfigured !== true}>
                        {busy ? <><span className="spinner" />Working</> : <>Approve &amp; create draft <Icon name="arrow" size={17} /></>}
                      </button>
                    </div>
                  )}

                  {invoiceId && (
                    <div className={`surface draft-surface${sent ? " is-sent" : ""}`} style={{ marginTop: 0 }} aria-labelledby="draft-title">
                      <div className="draft-heading">
                        <span className="draft-icon"><Icon name={sent ? "check" : "file"} size={20} /></span>
                        <div>
                          <h2 id="draft-title">{sent ? "Invoice sent" : "Sandbox draft created"}</h2>
                          <p>{sent ? "PayPal accepted the send request." : "Approve sending to issue the invoice to the buyer."}</p>
                        </div>
                      </div>
                      <div className="draft-reference"><span>PayPal invoice ID</span><code>{invoiceId}</code></div>
                      <div className="draft-actions">
                        {sent && invoiceUrl && (
                          <a className="button-secondary" href={invoiceUrl} target="_blank" rel="noreferrer">
                            Open hosted invoice <Icon name="arrow" size={16} />
                          </a>
                        )}
                        {!sent && (
                          <button type="button" className="button-primary" onClick={sendInvoice} disabled={busy || !sendToken}>
                            {busy ? <><span className="spinner" />Sending</> : <>Approve &amp; send invoice <Icon name="arrow" size={17} /></>}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              )}

              {/* MULTI-INVOICE APPROVALS & BATCH CARDS (Rendered when multi-report detected) */}
              {batchReviews.length > 1 && (
                <section className="surface draft-surface" style={{ marginTop: 0 }} aria-labelledby="batch-heading">
                  <div className="draft-heading">
                    <span className="draft-icon"><Icon name={activePendingCount === 0 ? "check" : "file"} size={20} /></span>
                    <div>
                      <h2 id="batch-heading">Multi-Invoice Reports ({activeBatchReviews.length})</h2>
                      <p>{activePendingCount === 0 ? "All detected invoices have been sent through PayPal Sandbox." : "Review each report. Approve individually with the side button, dismiss with ✕, or approve all at once below."}</p>
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
                          {/* Left: Report info */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
                              <strong style={{ fontSize: "14px", color: "#0f172a" }}>{rep.sectionTitle}</strong>
                              <span
                                style={{
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  background: st.sent ? "rgba(16, 185, 129, 0.15)" : isReady ? "rgba(2, 132, 199, 0.12)" : "rgba(239, 68, 68, 0.12)",
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

                          {/* Right: Actions */}
                          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                            {st.sent && st.url ? (
                              <a
                                className="button-secondary"
                                href={st.url}
                                target="_blank"
                                rel="noreferrer"
                                style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", padding: "8px 12px" }}
                              >
                                Open hosted invoice <Icon name="arrow" size={14} />
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

                  {/* Big prominent button at bottom to approve all at the same time */}
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
              <p style={{ margin: "12px 0 20px", color: "var(--muted)" }}>Please complete the invoice details and run preflight first.</p>
              <button type="button" className="button-primary" onClick={() => setActiveStep(0)}>← Go to invoice details</button>
            </div>
          )}
        </section>

        <aside className="side-column" aria-label="Evidence and process information">
          <section className="evidence-panel">
            <div className="side-panel-heading"><span className="side-icon"><Icon name="file" size={18} /></span><div><h2>Evidence &amp; checks</h2><p>What this review can prove</p></div></div>
            {review?.input.evidence?.length ? <div className="evidence-list">{review.input.evidence.map((ref, index) => <blockquote className="evidence-quote" key={`${ref.document}-${ref.page}-${index}`}>
              <span className="quote-mark">“</span><p>{ref.quote}</p><footer><Icon name="file" size={13} />{ref.document}{ref.page ? <span> · page {ref.page}</span> : null}</footer>
            </blockquote>)}</div> : <div className="evidence-empty"><span className="empty-icon"><Icon name="upload" size={19} /></span><strong>{file ? "Source evidence will appear here" : "Add a source document"}</strong><p>Searchable PO or SOW text can support extracted values and help explain a finding.</p></div>}
            <div className="side-panel-divider" />
            <div className="check-list-title"><Icon name="shield" size={16} /><strong>Deterministic checks</strong></div>
            <ul className="check-list"><li><Icon name="check" size={15} />Required buyer and invoice fields</li><li><Icon name="check" size={15} />Line item math and currency format</li><li><Icon name="check" size={15} />Stated PO maximum</li><li><Icon name="check" size={15} />Buyer, vendor, and PO consistency</li></ul>
            <p className="check-footnote">AI can suggest and explain. It cannot clear a blocking check.</p>
          </section>

          <section className="process-panel">
            <span className="process-kicker">YOUR CONTROL, EACH STEP</span>
            <h2>A review before the send.</h2>
            <ol className="process-list"><li><span className="process-marker">1</span><div><strong>Enter the invoice</strong><p>Upload a searchable PDF or type the terms yourself.</p></div></li><li><span className="process-marker">2</span><div><strong>Resolve what’s unclear</strong><p>Inspect the math, findings, and source evidence.</p></div></li><li><span className="process-marker">3</span><div><strong>Approve PayPal actions</strong><p>Draft creation and sending are separate approvals.</p></div></li></ol>
            <div className="sandbox-note"><span className="sandbox-note-dot" /><p><strong>Sandbox workspace</strong><br />{paypalConfigured === true ? "PayPal sandbox is connected. No live funds move." : "Connect PayPal sandbox credentials to enable invoice actions."}</p></div>
          </section>

          <footer className="workspace-footer"><span className="footer-mark">IR</span><span>Invoice Ready</span><span className="footer-divider" /><span>Evidence before you bill.</span></footer>
        </aside>
      </div>
    </main>
  );
}
