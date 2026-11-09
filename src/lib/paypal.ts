import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";

let instance: PayPalAgentToolkit | null = null;

export function paypalTools() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("PayPal sandbox credentials are not configured.");
  }
  if (!instance) {
    instance = new PayPalAgentToolkit({
      clientId,
      clientSecret,
      configuration: {
        context: { sandbox: true },
        actions: {
          invoices: { create: true, get: true, send: true, list: true, search: true },
          orders: { create: true, get: true, capture: true },
        },
      },
    });
  }
  return instance.getTools();
}

export async function paypalCreateDraft(input: Record<string, unknown>) {
  try {
    const tools = paypalTools();
    const tool = tools.create_invoice;
    if (tool?.execute) {
      const res = await tool.execute(input, { toolCallId: crypto.randomUUID(), messages: [] } as never);
      if (res && typeof res === "object" && !("error" in (res as Record<string, unknown>))) {
        return res;
      }
    }
  } catch (err) {
    console.warn("PayPal agent-toolkit create_invoice failed, attempting direct REST:", err);
  }

  const accessToken = await getPayPalAccessToken();
  const baseUrl =
    process.env.PAYPAL_API_BASE_URL ||
    (process.env.PAYPAL_SANDBOX === "false"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com");

  const res = await fetch(`${baseUrl}/v2/invoicing/invoices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(input),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const details = Array.isArray(data.details)
      ? (data.details as Array<{ description?: string; issue?: string }>).map((d) => d.description || d.issue).join("; ")
      : "";
    throw new Error(details || (data.message as string) || "PayPal Invoicing API rejected invoice draft creation.");
  }
  return data;
}

export async function paypalSendInvoice(input: Record<string, unknown>) {
  const invoiceId = String(input.invoice_id || input.id || "");
  try {
    const tools = paypalTools();
    const tool = tools.send_invoice;
    if (tool?.execute) {
      const res = await tool.execute(input, { toolCallId: crypto.randomUUID(), messages: [] } as never);
      if (res && typeof res === "object" && !("error" in (res as Record<string, unknown>))) {
        return res;
      }
    }
  } catch (err) {
    console.warn("PayPal agent-toolkit send_invoice failed, attempting direct REST:", err);
  }

  const accessToken = await getPayPalAccessToken();
  const baseUrl =
    process.env.PAYPAL_API_BASE_URL ||
    (process.env.PAYPAL_SANDBOX === "false"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com");

  const res = await fetch(`${baseUrl}/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ send_to_recipient: true }),
  });

  if (!res.ok) {
    const data = ((await res.json().catch(() => ({}))) || {}) as Record<string, unknown>;
    const details = Array.isArray(data.details)
      ? (data.details as Array<{ description?: string; issue?: string }>).map((d) => d.description || d.issue).join("; ")
      : "";
    throw new Error(details || (data.message as string) || "PayPal Invoicing API rejected invoice send.");
  }
  return { ok: true, invoiceId };
}

// ---------------------------------------------------------------------------
// Mock injection helpers for deterministic offline testing
// ---------------------------------------------------------------------------
export type CreateOrderMock = (input: Record<string, unknown>) => Promise<unknown> | unknown;
export type CaptureOrderMock = (orderId: string) => Promise<unknown> | unknown;
export type GetOrderMock = (orderId: string) => Promise<unknown> | unknown;

let mockCreateOrder: CreateOrderMock | null = null;
let mockCaptureOrder: CaptureOrderMock | null = null;
let mockGetOrder: GetOrderMock | null = null;

export function setPayPalOrderMocks(mocks: {
  createOrder?: CreateOrderMock;
  captureOrder?: CaptureOrderMock;
  getOrder?: GetOrderMock;
}) {
  if (mocks.createOrder !== undefined) mockCreateOrder = mocks.createOrder;
  if (mocks.captureOrder !== undefined) mockCaptureOrder = mocks.captureOrder;
  if (mocks.getOrder !== undefined) mockGetOrder = mocks.getOrder;
}

export function resetPayPalOrderMocks() {
  mockCreateOrder = null;
  mockCaptureOrder = null;
  mockGetOrder = null;
}

// ---------------------------------------------------------------------------
// Orders v2 Helper Functions
// ---------------------------------------------------------------------------
function normalizeToolResult(res: unknown): unknown {
  if (typeof res === "string") {
    try {
      return JSON.parse(res);
    } catch {
      return res;
    }
  }
  return res;
}

async function createOrderDirectRest(input: Record<string, unknown>) {
  const accessToken = await getPayPalAccessToken();
  const baseUrl =
    process.env.PAYPAL_API_BASE_URL ||
    (process.env.PAYPAL_SANDBOX === "false"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com");

  const currencyCode = (input.currencyCode as string) || (input.currency_code as string) || "USD";
  const items = Array.isArray(input.items) ? (input.items as Array<Record<string, unknown>>) : [];

  let calculatedTotal = 0;
  const purchaseItems = items.map((it) => {
    const cost = Number(it.itemCost ?? (it.unit_amount as Record<string, unknown>)?.value ?? 0);
    const qty = Number(it.quantity ?? 1);
    calculatedTotal += cost * qty;
    return {
      name: String(it.name || "Humanitarian Aid").slice(0, 127),
      description: it.description ? String(it.description).slice(0, 127) : undefined,
      quantity: String(qty),
      unit_amount: {
        currency_code: currencyCode,
        value: cost.toFixed(2),
      },
      category: "DONATION",
    };
  });

  const valueStr = calculatedTotal > 0 ? calculatedTotal.toFixed(2) : "50.00";

  const orderPayload: Record<string, unknown> = {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: String(input.notes || "DONATION").slice(0, 127),
        description: String(input.notes || "ClearAid Humanitarian Contribution").slice(0, 127),
        amount: {
          currency_code: currencyCode,
          value: valueStr,
          breakdown: {
            item_total: {
              currency_code: currencyCode,
              value: valueStr,
            },
          },
        },
        items: purchaseItems.length > 0 ? purchaseItems : undefined,
      },
    ],
  };

  const returnUrl = (input.returnUrl as string) || (input.return_url as string);
  const cancelUrl = (input.cancelUrl as string) || (input.cancel_url as string);
  if (returnUrl || cancelUrl) {
    orderPayload.payment_source = {
      paypal: {
        experience_context: {
          payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
          brand_name: "ClearAid",
          locale: "en-US",
          landing_page: "GUEST_CHECKOUT",
          user_action: "PAY_NOW",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
    };
  }

  const res = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(orderPayload),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    console.error("PayPal Orders v2 API error response:", data);
    const details = Array.isArray(data.details)
      ? (data.details as Array<{ description?: string; issue?: string }>).map((d) => d.description || d.issue).join("; ")
      : "";
    throw new Error(details || (data.message as string) || "PayPal Orders v2 API rejected order creation.");
  }
  return data;
}

export async function paypalCreateOrder(input: Record<string, unknown>) {
  if (mockCreateOrder) {
    return mockCreateOrder(input);
  }

  // 1. Native Cloudflare Workers & Node fetch to official PayPal Orders v2 REST API
  try {
    return await createOrderDirectRest(input);
  } catch (directErr) {
    console.warn("Direct Orders v2 REST API failed, attempting agent-toolkit fallback:", directErr);
    try {
      const tools = paypalTools();
      const tool = tools.create_order;
      if (tool?.execute) {
        const raw = await tool.execute(input, { toolCallId: crypto.randomUUID(), messages: [] } as never);
        const res = normalizeToolResult(raw);
        if (res && typeof res === "object" && !("error" in (res as Record<string, unknown>))) {
          return res;
        }
      }
    } catch {
      // Fall through
    }
    throw directErr;
  }
}

async function captureOrderDirectRest(orderId: string) {
  const accessToken = await getPayPalAccessToken();
  const baseUrl =
    process.env.PAYPAL_API_BASE_URL ||
    (process.env.PAYPAL_SANDBOX === "false"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com");

  const res = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({}),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    console.error("PayPal Orders v2 Capture error:", data);
    const details = Array.isArray(data.details)
      ? (data.details as Array<{ description?: string; issue?: string }>).map((d) => d.description || d.issue).join("; ")
      : "";
    throw new Error(details || (data.message as string) || "PayPal Orders v2 API rejected order capture.");
  }
  return data;
}

export async function paypalCaptureOrder(orderId: string) {
  if (mockCaptureOrder) {
    return mockCaptureOrder(orderId);
  }

  try {
    return await captureOrderDirectRest(orderId);
  } catch (directErr) {
    console.warn("Direct Orders v2 capture failed, attempting agent-toolkit fallback:", directErr);
    try {
      const tools = paypalTools();
      const tool = tools.pay_order;
      if (tool?.execute) {
        const raw = await tool.execute({ id: orderId }, { toolCallId: crypto.randomUUID(), messages: [] } as never);
        const res = normalizeToolResult(raw);
        if (res && typeof res === "object" && !("error" in (res as Record<string, unknown>))) {
          return res;
        }
      }
    } catch {
      // Fall through
    }
    throw directErr;
  }
}

async function getOrderDirectRest(orderId: string) {
  const accessToken = await getPayPalAccessToken();
  const baseUrl =
    process.env.PAYPAL_API_BASE_URL ||
    (process.env.PAYPAL_SANDBOX === "false"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com");

  const res = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const details = Array.isArray(data.details)
      ? (data.details as Array<{ description?: string; issue?: string }>).map((d) => d.description || d.issue).join("; ")
      : "";
    throw new Error(details || (data.message as string) || "PayPal Orders v2 API rejected order retrieval.");
  }
  return data;
}

export async function paypalGetOrder(orderId: string) {
  if (mockGetOrder) {
    return mockGetOrder(orderId);
  }

  try {
    return await getOrderDirectRest(orderId);
  } catch (directErr) {
    console.warn("Direct Orders v2 getOrder failed, attempting agent-toolkit fallback:", directErr);
    try {
      const tools = paypalTools();
      const tool = tools.get_order;
      if (tool?.execute) {
        const raw = await tool.execute({ id: orderId }, { toolCallId: crypto.randomUUID(), messages: [] } as never);
        const res = normalizeToolResult(raw);
        if (res && typeof res === "object" && !("error" in (res as Record<string, unknown>))) {
          return res;
        }
      }
    } catch {
      // Fall through
    }
    throw directErr;
  }
}

// ---------------------------------------------------------------------------
// Centralized In-Memory TTL OAuth Token Caching
// ---------------------------------------------------------------------------
interface CachedOAuthToken {
  accessToken: string;
  expiresAt: number; // Milliseconds Unix timestamp
}

let cachedOAuthToken: CachedOAuthToken | null = null;
let inflightTokenPromise: Promise<string> | null = null;

/**
 * Returns a valid PayPal OAuth2 access token, utilizing an in-memory cache
 * with a 60-second safety margin to avoid redundant round-trips.
 * Concurrent callers await the same inflight promise to avoid thundering herds.
 */
export async function getPayPalAccessToken(options?: { forceRefresh?: boolean }): Promise<string> {
  const now = Date.now();
  if (!options?.forceRefresh && cachedOAuthToken && now < cachedOAuthToken.expiresAt) {
    return cachedOAuthToken.accessToken;
  }

  // Deduplicate concurrent in-flight fetches
  if (inflightTokenPromise && !options?.forceRefresh) {
    return inflightTokenPromise;
  }

  inflightTokenPromise = (async () => {
    try {
      const clientId = process.env.PAYPAL_CLIENT_ID;
      const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error("PayPal sandbox credentials are not configured.");
      }

      const baseUrl =
        process.env.PAYPAL_API_BASE_URL ||
        (process.env.PAYPAL_SANDBOX === "false"
          ? "https://api-m.paypal.com"
          : "https://api-m.sandbox.paypal.com");

      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        throw new Error(`PayPal OAuth token request failed (${res.status}): ${errorText}`);
      }

      const data = (await res.json()) as { access_token: string; expires_in: number };
      if (!data.access_token) {
        throw new Error("PayPal OAuth response missing access_token");
      }

      const ttlSeconds = typeof data.expires_in === "number" ? data.expires_in : 3600;
      // Safety margin of 60 seconds (or 10% if short-lived)
      const safetyMarginMs = Math.min(60, Math.floor(ttlSeconds * 0.1)) * 1000;
      const expiresAt = now + Math.max(0, ttlSeconds * 1000 - safetyMarginMs);

      cachedOAuthToken = {
        accessToken: data.access_token,
        expiresAt,
      };

      return data.access_token;
    } finally {
      inflightTokenPromise = null;
    }
  })();

  return inflightTokenPromise;
}

/** Reset token cache for unit testing */
export function _resetPayPalTokenCache(): void {
  cachedOAuthToken = null;
  inflightTokenPromise = null;
}

/** Inspect cache status for unit testing */
export function _getPayPalTokenCacheStatus(): { cached: boolean; expiresInMs: number } {
  if (!cachedOAuthToken) return { cached: false, expiresInMs: 0 };
  const diff = cachedOAuthToken.expiresAt - Date.now();
  return { cached: diff > 0, expiresInMs: Math.max(0, diff) };
}
