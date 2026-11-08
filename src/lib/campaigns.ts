import type { ReliefCampaign, PublicDisbursementRecord } from "./types";

export const DEFAULT_CAMPAIGNS: ReliefCampaign[] = [
  {
    id: "CAMP-MED-01",
    title: "Emergency Trauma Kits & Surgical Field Hospital",
    subtitle: "Direct sterile surgical kits, portable anesthesia, and emergency trauma field stations for coastal cyclone response.",
    category: "Medical",
    targetMinor: 15000000, // $150,000.00
    raisedMinor: 9240000,  // $92,400.00
    disbursedMinor: 4070000, // $40,700.00
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
    raisedMinor: 5400000,  // $54,000.00
    disbursedMinor: 1820000, // $18,200.00
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
    raisedMinor: 8850000,  // $88,500.00
    disbursedMinor: 3640000, // $36,400.00
    currency: "USD",
    grantCode: "GRANT-RELIEF-2026-SHL03",
    leadAgency: "Rapid Habitat Response",
    disasterZone: "Alpine Earthquake Fault Sector",
    urgent: true,
  },
];

export const DEFAULT_DISBURSEMENTS: PublicDisbursementRecord[] = [
  {
    id: "DISB-8LT9-FGSB",
    campaignId: "CAMP-MED-01",
    campaignTitle: "Emergency Trauma Kits & Surgical Field Hospital",
    paypalInvoiceId: "INV2-8LT9-FGSB-PZ6Q-J684",
    vendorName: "Apex Cloud Systems & Studio Lab Inc.",
    category: "Enterprise Multi-VPC Medical Telemetry & Starlink Edge",
    amountMinor: 1250000, // $12,500.00
    currency: "USD",
    preflightProofHash: "sha256:7f3a9e21db4b8fc4aa913b8e72c5da191e48bc4a9d701f56d981e4b3",
    timestamp: "Nov 07, 2026 · 18:42 UTC",
    hostedInvoiceUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-8LT9-FGSB-PZ6Q-J684",
    status: "PAID_VIA_PAYPAL",
  },
  {
    id: "DISB-9FAY-ENJ3",
    campaignId: "CAMP-WATER-02",
    campaignTitle: "Clean Water Desalination & Solar Purification Rigs",
    paypalInvoiceId: "INV2-9FAY-ENJ3-VH2N-CN2E",
    vendorName: "OmniGlobal Operations Corp.",
    category: "Solar Reverse Osmosis Rigs & Chlorine Sachet Pallets",
    amountMinor: 1450000, // $14,500.00
    currency: "USD",
    preflightProofHash: "sha256:a4c82b196ff3dd7201cba639148bc291583099fe682918bbda821033",
    timestamp: "Nov 08, 2026 · 02:15 UTC",
    hostedInvoiceUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-9FAY-ENJ3-VH2N-CN2E",
    status: "PAID_VIA_PAYPAL",
  },
  {
    id: "DISB-Z9UV-28AS",
    campaignId: "CAMP-SHELTER-03",
    campaignTitle: "Rapid Thermal Shelters & Micro-Grid Generators",
    paypalInvoiceId: "INV2-Z9UV-28AS-RHV2-2R9Q",
    vendorName: "Nordic Field Power Systems LLC",
    category: "15kVA Whisper Generators, Distribution Panels & Cold Fuel",
    amountMinor: 940000, // $9,400.00
    currency: "USD",
    preflightProofHash: "sha256:e1b773c091adbb620947ba9811eef4a898b112ca001fe82914ba1139",
    timestamp: "Nov 08, 2026 · 04:30 UTC",
    hostedInvoiceUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-Z9UV-28AS-RHV2-2R9Q",
    status: "PAID_VIA_PAYPAL",
  },
];

export function formatCurrencyMinor(minor: number, currency = "USD"): string {
  const amount = (minor / 100).toFixed(2);
  const formatted = Number(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `$${formatted}`;
}

export function getRemainingGrantCapMinor(campaign: ReliefCampaign): number {
  // Remaining uncommitted budget = raised donations - already disbursed
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
    category: string;
    amountMinor: number;
    currency: string;
    preflightProofHash: string;
    hostedInvoiceUrl?: string;
  }
): {
  campaigns: ReliefCampaign[];
  disbursements: PublicDisbursementRecord[];
  newRecord: PublicDisbursementRecord;
} {
  const newRecord: PublicDisbursementRecord = {
    id: `DISB-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    campaignId: data.campaignId,
    campaignTitle: data.campaignTitle,
    paypalInvoiceId: data.paypalInvoiceId,
    vendorName: data.vendorName,
    category: data.category,
    amountMinor: data.amountMinor,
    currency: data.currency,
    preflightProofHash: data.preflightProofHash,
    timestamp: new Date().toUTCString().replace("GMT", "UTC"),
    hostedInvoiceUrl: data.hostedInvoiceUrl,
    status: "PAID_VIA_PAYPAL",
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
