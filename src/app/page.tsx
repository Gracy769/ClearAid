"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { ReviewInput, ReviewResult } from "@/lib/types";

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
      setData(body.review.input);
      setReview(body.review);
      setReviewId(body.reviewId);
      setApprovalToken(body.approvalToken);
      setAiUsed(Boolean(body.aiUsed));
      setNotice({ kind: "success", text: body.aiUsed ? "Suggestions are ready. Check each value against the source before approval." : "Preflight is complete. Review the findings and invoice details below." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The review could not be completed." });
    } finally {
      setBusy(false);
    }
  }

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

  function addItem() {
    invalidateReview();
    setData((current) => ({ ...current, items: [...current.items, { description: "", quantity: "1", unitAmount: "" }] }));
  }

  function removeItem(index: number) {
    invalidateReview();
    setData((current) => ({ ...current, items: current.items.filter((_, i) => i !== index) }));
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#main" aria-label="Invoice Ready home">
            <span className="brand-mark" aria-hidden="true">IR</span>
            <span className="brand-name">Invoice Ready</span>
          </a>
          <div className="topbar-note"><Icon name="shield" size={16} /><span>Your invoice stays in your control</span></div>
          <span className="sandbox-badge"><span className="sandbox-dot" />SANDBOX</span>
        </div>
      </header>

      <nav className="workflow-rail" aria-label="Invoice review progress">
        <ol className="workflow-inner">
          {["Invoice details", "Preflight", "PayPal approval"].map((label, index) => {
            const complete = index < step;
            const active = index === step;
            return <li key={label} className={`workflow-step${active ? " is-active" : ""}${complete ? " is-complete" : ""}`} aria-current={active ? "step" : undefined}>
              <span className="step-marker">{complete ? <Icon name="check" size={14} /> : <span className="step-dot" />}</span>
              <span>{label}</span>
              {index < 2 && <span className="step-connector" aria-hidden="true" />}
            </li>;
          })}
        </ol>
      </nav>

      <div className="workspace" id="main">
        <section className="main-column" aria-labelledby="page-title">
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
                  <span>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · Searchable PDF` : "Drop a searchable PDF here, or browse · up to 8 MB"}</span>
                </span>
                <input id="po-file" className="visually-hidden" type="file" accept="application/pdf,.pdf" onChange={(event) => { invalidateReview(); setFile(event.target.files?.[0] || null); }} />
              </label>
              {file && <button type="button" className="icon-button file-remove" aria-label="Remove uploaded file" onClick={() => { invalidateReview(); setFile(null); }}><Icon name="close" size={16} /></button>}
            </div>
            <p className="privacy-note"><Icon name="shield" size={14} />The original PDF is processed for this review and is not retained.</p>

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
              <div className="line-items-head"><span>Service or deliverable</span><span>Qty</span><span>Unit rate</span><span className="line-action-label">Remove</span></div>
              <div className="line-items-list">
                {data.items.map((item, index) => <div className="line-item" key={index}>
                  <label className="visually-hidden" htmlFor={`item-description-${index}`}>Service or deliverable, line {index + 1}</label>
                  <input id={`item-description-${index}`} value={item.description} onChange={(event) => updateItem(index, "description", event.target.value)} placeholder="Design services" />
                  <label className="visually-hidden" htmlFor={`item-quantity-${index}`}>Quantity, line {index + 1}</label>
                  <input id={`item-quantity-${index}`} type="number" min="1" step="1" inputMode="numeric" value={item.quantity} onChange={(event) => updateItem(index, "quantity", event.target.value)} />
                  <label className="visually-hidden" htmlFor={`item-rate-${index}`}>Unit rate, line {index + 1}</label>
                  <div className="rate-input"><span>{data.currency || "USD"}</span><input id={`item-rate-${index}`} inputMode="decimal" value={item.unitAmount} onChange={(event) => updateItem(index, "unitAmount", event.target.value)} placeholder="0.00" /></div>
                  <button type="button" className="icon-button remove-line" onClick={() => removeItem(index)} disabled={data.items.length === 1} aria-label={`Remove line ${index + 1}`}><Icon name="trash" size={17} /></button>
                </div>)}
              </div>
              <button type="button" className="add-line" onClick={addItem}><Icon name="plus" size={16} />Add a line item</button>
              <div className="invoice-total"><span>Invoice total</span><strong>{formatMoney(previewMinor, data.currency)}</strong></div>
            </fieldset>

            {aiUsed && <div className="suggestion-banner"><span className="suggestion-icon"><Icon name="spark" size={17} /></span><p><strong>AI suggestions added.</strong> Verify the business names, PO number, and terms against the source evidence before approval.</p></div>}

            <div className="form-footer">
              <span className="footer-note">You review each field before any PayPal action.</span>
              <button className="button-primary" type="submit" disabled={busy}>
                {busy ? <><span className="spinner" />Checking invoice</> : <>Run preflight <Icon name="arrow" size={17} /></>}
              </button>
            </div>
          </form>

          {notice && <div className={`notice notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"} aria-live="polite"><Icon name={notice.kind === "error" ? "alert" : "check"} size={18} /><span>{notice.text}</span></div>}

          {review && <section className="surface result-surface" aria-labelledby="result-title">
            <div className="result-topline">
              <div><h2 id="result-title">Preflight result</h2><p>{review.findings.length ? "Review the findings before creating a draft." : "No deterministic blockers found. Confirm the details before approval."}</p></div>
              <span className={`status-badge status-${review.status.toLowerCase()}`}><span className="status-icon"><Icon name={review.status === "READY" ? "check" : "alert"} size={14} /></span>{review.status}</span>
            </div>

            <div className="total-callout"><span>Invoice total</span><strong>{formatMoney(review.totalMinor, review.input.currency)}</strong><span className="total-currency">{review.input.currency}</span></div>

            {review.findings.length > 0 && <ul className="findings-list">{review.findings.map((finding, index) => <li key={`${finding.code}-${index}`} className={`finding finding-${finding.severity}`}>
              <Icon name={finding.severity === "block" ? "alert" : "file"} size={18} />
              <div><strong>{finding.severity === "block" ? "Hold" : "Review"}</strong><p>{finding.message}</p></div>
            </li>)}</ul>}

            {review.status === "READY" && <div className="approval-row"><div><strong>Ready for your approval</strong><span>{paypalConfigured === true ? "Creating a draft does not send it." : paypalConfigured === false ? "Add PayPal sandbox credentials to enable invoice actions." : "Checking PayPal sandbox connection…"}</span></div><button type="button" className="button-primary" onClick={createDraft} disabled={busy || !approvalToken || paypalConfigured !== true}>{busy ? <><span className="spinner" />Working</> : <>Approve &amp; create draft <Icon name="arrow" size={17} /></>}</button></div>}
          </section>}

          {invoiceId && <section className={`surface draft-surface${sent ? " is-sent" : ""}`} aria-labelledby="draft-title">
            <div className="draft-heading"><span className="draft-icon"><Icon name={sent ? "check" : "file"} size={20} /></span><div><h2 id="draft-title">{sent ? "Invoice sent" : "Sandbox draft created"}</h2><p>{sent ? "PayPal accepted the send request." : "Review the hosted invoice, then approve sending as a separate step."}</p></div></div>
            <div className="draft-reference"><span>PayPal invoice ID</span><code>{invoiceId}</code></div>
            <div className="draft-actions">{invoiceUrl && <a className="button-secondary" href={invoiceUrl} target="_blank" rel="noreferrer">Open hosted invoice <Icon name="arrow" size={16} /></a>}{!sent && <button type="button" className="button-primary" onClick={sendInvoice} disabled={busy || !sendToken}>{busy ? <><span className="spinner" />Sending</> : <>Approve &amp; send invoice <Icon name="arrow" size={17} /></>}</button>}</div>
          </section>}
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
