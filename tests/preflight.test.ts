import assert from "node:assert/strict";
import test from "node:test";
import { runPreflight } from "../src/lib/preflight";
import type { ReviewInput } from "../src/lib/types";

const valid: ReviewInput = {
  vendorName: "Northstar Studio",
  buyerName: "Acme",
  buyerEmail: "ap@example.com",
  poNumber: "PO-1042",
  currency: "USD",
  poCap: "1250.00",
  items: [{ description: "Design services", quantity: "3", unitAmount: "250.50" }],
  evidence: [{ document: "PO.pdf", page: 1, quote: "PO-1042 design services" }],
};

test("calculates invoice totals in exact minor units", () => {
  assert.equal(runPreflight(valid).totalMinor, 75150);
  assert.equal(runPreflight(valid).status, "READY");
});

test("holds when the invoice exceeds the PO cap", () => {
  const result = runPreflight({ ...valid, poCap: "700.00" });
  assert.equal(result.status, "HOLD");
  assert.ok(result.findings.some((finding) => finding.code === "po_cap_exceeded"));
});

test("holds malformed amounts and missing buyer details", () => {
  const result = runPreflight({ ...valid, buyerEmail: "", items: [{ ...valid.items[0], unitAmount: "12.999" }] });
  assert.equal(result.status, "HOLD");
  assert.ok(result.findings.some((finding) => finding.code === "missing_buyerEmail"));
  assert.ok(result.findings.some((finding) => finding.code === "item_0_rate"));
});

test("warns when there is no source evidence", () => {
  const result = runPreflight({ ...valid, evidence: undefined });
  assert.ok(result.findings.some((finding) => finding.code === "no_source_evidence"));
});
