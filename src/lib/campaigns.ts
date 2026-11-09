import { randomUUID } from "node:crypto";
import type { ReliefCampaign, PublicDisbursementRecord } from "./types";

export const DEFAULT_CAMPAIGNS: ReliefCampaign[] = [
  {
    id: "CAMP-MED-01",
    title: "Emergency Trauma Kits & Surgical Field Hospital",
    subtitle: "Direct sterile surgical kits, portable anesthesia, and emergency trauma field stations for coastal cyclone response.",
    category: "Medical",
    targetMinor: 15000000, // $150,000.00
    raisedMinor: 0,
    disbursedMinor: 0,
    currency: "USD",
    grantCode: "GRANT-RELIEF-2026-MED01",
    leadAgency: "Global Emergency Health Corps",
    disasterZone: "Southern Coastal Cyclone Zone (Sector 4)",
    urgent: true,
  },
  {
    id: "CAMP-WATER-02",
    title: "Clean Water Desalination & Solar Purification Rigs",
    subtitle: "Solar-powered reverse osmosis units and bulk 20L Jerrycan supply to 14,000 displaced families.",
    category: "Water & Sanitation",
    targetMinor: 8000000,  // $80,000.00
    raisedMinor: 0,
    disbursedMinor: 0,
    currency: "USD",
    grantCode: "GRANT-RELIEF-2026-WTR02",
    leadAgency: "PureRelief International",
    disasterZone: "Riverine Basin Inundation Corridor",
    urgent: false,
  },
  {
    id: "CAMP-SHELTER-03",
    title: "Rapid Thermal Shelters & Micro-Grid Generators",
    subtitle: "Heavy insulated winter survival tents, 15kVA whisper-quiet diesel generators, and emergency grid batteries.",
    category: "Shelter & Power",
    targetMinor: 12000000, // $120,000.00
    raisedMinor: 0,
    disbursedMinor: 0,
    currency: "USD",
    grantCode: "GRANT-RELIEF-2026-SHL03",
    leadAgency: "Rapid Habitat Response",
    disasterZone: "Alpine Earthquake Fault Sector",
    urgent: true,
  },
];

export const DEFAULT_DISBURSEMENTS: PublicDisbursementRecord[] = [];

export function formatCurrencyMinor(minor: number, currency = "USD"): string {
  const amount = (minor / 100).toFixed(2);
  const formatted = Number(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "USD" ? `$${formatted}` : `${currency} ${formatted}`;
}

export function getRemainingGrantCapMinor(campaign: ReliefCampaign): number {
  const remaining = campaign.raisedMinor - campaign.disbursedMinor;
  return Math.max(0, remaining);
}

export function recordDonation(
  campaigns: ReliefCampaign[],
  campaignId: string,
  amountMinor: number
): ReliefCampaign[] {
  return campaigns.map((c) => {
    if (c.id === campaignId) {
      return {
        ...c,
        raisedMinor: c.raisedMinor + amountMinor,
      };
    }
    return c;
  });
}

export function recordDisbursement(
  campaigns: ReliefCampaign[],
  disbursements: PublicDisbursementRecord[],
  data: {
    campaignId: string;
    campaignTitle: string;
    paypalInvoiceId: string;
    vendorName: string;
    buyerName?: string;
    grantCode?: string;
    category: string;
    amountMinor: number;
    currency: string;
    preflightProofHash: string;
    hostedInvoiceUrl?: string;
    items?: Array<{ description: string; quantity: string; unitAmount: string }>;
  }
): {
  campaigns: ReliefCampaign[];
  disbursements: PublicDisbursementRecord[];
  newRecord: PublicDisbursementRecord;
} {
  const idSuffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const newRecord: PublicDisbursementRecord = {
    id: `DISB-${idSuffix.slice(0, 4)}-${idSuffix.slice(4, 8)}`,
    campaignId: data.campaignId,
    campaignTitle: data.campaignTitle,
    paypalInvoiceId: data.paypalInvoiceId,
    vendorName: data.vendorName,
    buyerName: data.buyerName,
    grantCode: data.grantCode,
    category: data.category,
    amountMinor: data.amountMinor,
    currency: data.currency,
    preflightProofHash: data.preflightProofHash,
    timestamp: new Date().toUTCString().replace("GMT", "UTC"),
    hostedInvoiceUrl: data.hostedInvoiceUrl,
    status: "PAID_VIA_PAYPAL",
    isSimulated: false,
    items: data.items,
  };

  const updatedCampaigns = campaigns.map((c) => {
    if (c.id === data.campaignId) {
      return {
        ...c,
        disbursedMinor: c.disbursedMinor + data.amountMinor,
      };
    }
    return c;
  });

  return {
    campaigns: updatedCampaigns,
    disbursements: [newRecord, ...disbursements],
    newRecord,
  };
}
