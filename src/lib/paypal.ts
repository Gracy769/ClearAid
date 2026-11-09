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
  const tools = paypalTools();
  const tool = tools.create_invoice;
  if (!tool?.execute) throw new Error("PayPal invoice creation tool is unavailable.");
  return tool.execute(input, { toolCallId: crypto.randomUUID(), messages: [] } as never);
}

export async function paypalSendInvoice(input: Record<string, unknown>) {
  const tools = paypalTools();
  const tool = tools.send_invoice;
  if (!tool?.execute) throw new Error("PayPal invoice sending tool is unavailable.");
  return tool.execute(input, { toolCallId: crypto.randomUUID(), messages: [] } as never);
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

export async function paypalCreateOrder(input: Record<string, unknown>) {
  if (mockCreateOrder) {
    return mockCreateOrder(input);
  }
  const tools = paypalTools();
  const tool = tools.create_order;
  if (!tool?.execute) throw new Error("PayPal create_order tool is unavailable.");
  const raw = await tool.execute(input, { toolCallId: crypto.randomUUID(), messages: [] } as never);
  return normalizeToolResult(raw);
}

export async function paypalCaptureOrder(orderId: string) {
  if (mockCaptureOrder) {
    return mockCaptureOrder(orderId);
  }
  const tools = paypalTools();
  const tool = tools.pay_order;
  if (!tool?.execute) throw new Error("PayPal pay_order tool is unavailable.");
  const raw = await tool.execute({ id: orderId }, { toolCallId: crypto.randomUUID(), messages: [] } as never);
  return normalizeToolResult(raw);
}

export async function paypalGetOrder(orderId: string) {
  if (mockGetOrder) {
    return mockGetOrder(orderId);
  }
  const tools = paypalTools();
  const tool = tools.get_order;
  if (!tool?.execute) throw new Error("PayPal get_order tool is unavailable.");
  const raw = await tool.execute({ id: orderId }, { toolCallId: crypto.randomUUID(), messages: [] } as never);
  return normalizeToolResult(raw);
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
