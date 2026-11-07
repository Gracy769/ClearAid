import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractMultiReportsFromPdfText } from "../src/lib/pdf-extract.ts";

describe("Multi-Invoice PDF Segmentation Engine", () => {
  it("classifies single statement of work as isMulti: false", () => {
    const singleDoc = `
BUYER / PRINCIPAL:
OmniGlobal Operations Corp.
VENDOR / SERVICE PROVIDER:
Apex Cloud Systems Inc.
PURCHASE ORDER NUMBER: PO-1042
ACCOUNTS PAYABLE SUBMISSION:
Authorized Recipient Email: ap@omniglobal.com
1. Enterprise Cloud Architecture 40 $200.00 $8,000.00
`;
    const result = extractMultiReportsFromPdfText(singleDoc);
    assert.equal(result.isMulti, false);
    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0].terms.poNumber, "PO-1042");
    assert.equal(result.reports[0].terms.vendorName, "Apex Cloud Systems Inc.");
    assert.equal(result.reports[0].terms.buyerName, "OmniGlobal Operations Corp.");
    assert.equal(result.reports[0].terms.buyerEmail, "ap@omniglobal.com");
  });

  it("detects and segments multiple reports with shared entity inheritance", () => {
    const multiDoc = `
BUYER / PRINCIPAL:
Global Media Group LLC
VENDOR / SERVICE PROVIDER:
Apex Studio Engineering Inc.
ACCOUNTS PAYABLE SUBMISSION:
Authorized Recipient Email: billing@globalmedia.com
PO-MASTER-2026

REPORT 1: Cloud Edge Infrastructure
PO Number: PO-GMG-2026-01
1. Cloudflare Workers Edge Setup 20 $150.00 $3,000.00
2. Neon Serverless Postgres Setup 15 $200.00 $3,000.00

REPORT 2: Next.js Frontend Development
PO Number: PO-GMG-2026-02
1. App Router RSC Migration 30 $140.00 $4,200.00
2. PayPal SDK Integration 25 $180.00 $4,500.00

REPORT 3: Penetration Testing & Compliance
PO Number: PO-GMG-2026-03
1. SOC2 Type II Audit Retainer 1 $5,000.00 $5,000.00
`;
    const result = extractMultiReportsFromPdfText(multiDoc);
    assert.equal(result.isMulti, true);
    assert.equal(result.reports.length, 3);

    // Report 1 checks
    assert.ok(result.reports[0].title.includes("REPORT 1"));
    assert.equal(result.reports[0].terms.buyerName, "Global Media Group LLC");
    assert.equal(result.reports[0].terms.vendorName, "Apex Studio Engineering Inc.");
    assert.equal(result.reports[0].terms.buyerEmail, "billing@globalmedia.com");
    assert.equal(result.reports[0].terms.poNumber, "PO-GMG-2026-01");
    assert.equal(result.reports[0].terms.items?.length, 2);

    // Report 2 checks
    assert.ok(result.reports[1].title.includes("REPORT 2"));
    assert.equal(result.reports[1].terms.buyerName, "Global Media Group LLC");
    assert.equal(result.reports[1].terms.vendorName, "Apex Studio Engineering Inc.");
    assert.equal(result.reports[1].terms.buyerEmail, "billing@globalmedia.com");
    assert.equal(result.reports[1].terms.poNumber, "PO-GMG-2026-02");
    assert.equal(result.reports[1].terms.items?.length, 2);

    // Report 3 checks
    assert.ok(result.reports[2].title.includes("REPORT 3"));
    assert.equal(result.reports[2].terms.buyerName, "Global Media Group LLC");
    assert.equal(result.reports[2].terms.poNumber, "PO-GMG-2026-03");
    assert.equal(result.reports[2].terms.items?.length, 1);
  });
});
