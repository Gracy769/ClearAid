import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CAMPAIGNS,
  DEFAULT_DISBURSEMENTS,
  formatCurrencyMinor,
  getRemainingGrantCapMinor,
  recordDonation,
  recordDisbursement,
} from "../src/lib/campaigns";
import { runPreflight } from "../src/lib/preflight";
import type { ReviewInput } from "../src/lib/types";

describe("Relief Ready Campaign & Inflow Math", () => {
  it("formats minor units cleanly into USD currency strings", () => {
    assert.equal(formatCurrencyMinor(100), "$1.00");
    assert.equal(formatCurrencyMinor(4070000), "$40,700.00");
    assert.equal(formatCurrencyMinor(0), "$0.00");
    assert.equal(formatCurrencyMinor(15000000), "$150,000.00");
  });

  it("calculates remaining uncommitted grant pool correctly", () => {
    const medCamp = DEFAULT_CAMPAIGNS[0];
    // raised $92,400.00 (9240000), disbursed $40,700.00 (4070000)
    // remaining = 5170000 ($51,700.00)
    assert.equal(getRemainingGrantCapMinor(medCamp), 5170000);
  });

  it("increments campaign raisedMinor on recorded donation without mutating original", () => {
    const initial = DEFAULT_CAMPAIGNS;
    const donationAmountMinor = 5000; // $50.00
    const updated = recordDonation(initial, "CAMP-MED-01", donationAmountMinor);

    assert.notEqual(initial, updated);
    const updatedMed = updated.find((c) => c.id === "CAMP-MED-01");
    assert.equal(updatedMed?.raisedMinor, 9240000 + 5000);
    // original remains intact
    assert.equal(initial[0].raisedMinor, 9240000);
  });

  it("records disbursement and appends to transparency ledger without drift", () => {
    const initialCampaigns = DEFAULT_CAMPAIGNS;
    const initialDisbursements = DEFAULT_DISBURSEMENTS;

    const { campaigns, disbursements, newRecord } = recordDisbursement(
      initialCampaigns,
      initialDisbursements,
      {
        campaignId: "CAMP-MED-01",
        campaignTitle: "Emergency Trauma Kits",
        paypalInvoiceId: "INV2-TEST-1234-5678",
        vendorName: "Field Medics Ltd",
        category: "Trauma Packs",
        amountMinor: 250000, // $2,500.00
        currency: "USD",
        preflightProofHash: "sha256:mockhash123",
        hostedInvoiceUrl: "https://sandbox.paypal.com/mock",
      }
    );

    assert.equal(disbursements.length, initialDisbursements.length + 1);
    assert.equal(disbursements[0].paypalInvoiceId, "INV2-TEST-1234-5678");
    assert.equal(disbursements[0].status, "PAID_VIA_PAYPAL");
    const updatedMed = campaigns.find((c) => c.id === "CAMP-MED-01");
    assert.equal(updatedMed?.disbursedMinor, 4070000 + 250000);
  });

  it("binds campaign remaining cap to preflight and halts over-budget invoice", () => {
    const medCamp = DEFAULT_CAMPAIGNS[0];
    const remainingMinor = getRemainingGrantCapMinor(medCamp); // $51,700.00
    const remainingCapFormatted = (remainingMinor / 100).toFixed(2); // "51700.00"

    // Valid invoice below remaining cap ($40,700.00 <= $51,700.00)
    const validBill: ReviewInput = {
      vendorName: "Apex Cloud Systems",
      buyerName: "Global Emergency Health Corps",
      buyerEmail: "procurement@gehc.org",
      poNumber: medCamp.grantCode,
      currency: "USD",
      poCap: remainingCapFormatted,
      items: [
        {
          description: "Trauma Surgical Telemetry Node",
          quantity: "1",
          unitAmount: "40700.00",
        },
      ],
      evidence: [{ document: "Grant-Award.pdf", quote: "Cap approved" }],
    };

    const validResult = runPreflight(validBill);
    assert.equal(validResult.status, "READY");

    // Over-budget invoice ($60,000.00 > $51,700.00)
    const overBudgetBill: ReviewInput = {
      ...validBill,
      items: [
        {
          description: "Unauthorized Mobile Hospital Expansion",
          quantity: "1",
          unitAmount: "60000.00",
        },
      ],
    };

    const blockedResult = runPreflight(overBudgetBill);
    assert.equal(blockedResult.status, "HOLD");
    const capFinding = blockedResult.findings.find(
      (f) => f.code === "po_cap_exceeded"
    );
    assert.ok(capFinding, "Must find po_cap_exceeded finding");
  });
});
