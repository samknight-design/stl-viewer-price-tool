// supabase/functions/shopify-relay/index.ts
import { getShopConfig, saveShopConfig } from "./config.ts";
import { uploadFile } from "./files.ts";
import { createPricedVariant } from "./variant.ts";
import { createDraftOrder, type QuoteLineItem } from "./draftOrder.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-admin-password",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

// Sentinel thrown by readJsonBody() and caught right at the call site (not
// the outer generic-500 handler) so a malformed/non-JSON request body is a
// 400 client error, not a 500 — the outer catch is for genuine server-side
// failures further down (Shopify API errors, etc.).
class BadJsonError extends Error {}

async function readJsonBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new BadJsonError("Malformed JSON request body");
  }
}

/**
 * Dependencies the router dispatches to. Exposed as a parameter (rather than
 * imported directly at call sites) so tests can substitute fakes without
 * fighting Deno's non-configurable ES module exports — see index.test.ts.
 */
export interface RelayDeps {
  getShopConfig: typeof getShopConfig;
  saveShopConfig: typeof saveShopConfig;
  uploadFile: typeof uploadFile;
  createPricedVariant: typeof createPricedVariant;
  createDraftOrder: typeof createDraftOrder;
}

const defaultDeps: RelayDeps = {
  getShopConfig,
  saveShopConfig,
  uploadFile,
  createPricedVariant,
  createDraftOrder,
};

export async function handleRequest(
  req: Request,
  deps: RelayDeps = defaultDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const url = new URL(req.url);

    if (url.pathname.endsWith("/config") && req.method === "GET") {
      const config = await deps.getShopConfig();
      return json({ config });
    }

    if (url.pathname.endsWith("/config") && req.method === "POST") {
      const adminPassword = Deno.env.get("ADMIN_PASSWORD");
      if (!adminPassword || req.headers.get("x-admin-password") !== adminPassword) {
        return json({ error: "Unauthorized" }, 401);
      }
      const { config } = await readJsonBody(req);
      await deps.saveShopConfig(config);
      return json({ ok: true });
    }

    if (url.pathname.endsWith("/files") && req.method === "POST") {
      const { filename, mimeType, base64Data } = await readJsonBody(req);
      const file = await deps.uploadFile({ filename, mimeType, base64Data });
      return json(file);
    }

    if (url.pathname.endsWith("/checkout") && req.method === "POST") {
      const body = await readJsonBody(req) as {
        customerEmail: string;
        customerName: string;
        grandTotal: number;
        thresholdExceeded: boolean;
        lineItems: QuoteLineItem[];
      };

      // --- Server-side sanity checks on client-supplied pricing data ---
      // This endpoint is public and unauthenticated, so grandTotal and
      // thresholdExceeded cannot be trusted as-is: anyone can POST an
      // arbitrary total or clear the manual-review flag to bypass it.
      if (
        typeof body.grandTotal !== "number" ||
        !Number.isFinite(body.grandTotal) ||
        body.grandTotal <= 0
      ) {
        return json({ error: "Invalid grandTotal" }, 400);
      }
      if (!Array.isArray(body.lineItems) || body.lineItems.length === 0) {
        return json({ error: "Invalid lineItems" }, 400);
      }

      const computedTotal = body.lineItems.reduce(
        (sum, li) => sum + (Number(li.price) || 0) * (Number(li.quantity) || 0),
        0,
      );

      // Fetch shop config once, up front — used both to re-derive the
      // expected grandTotal (line items are priced BEFORE the whole-order
      // minimum is applied, so the frontend bumps grandTotal up to
      // minimumOrderTotal for small orders — see js/calculator.js's
      // calcOrderTotal) and for the manual-review threshold check below.
      const shopConfig = await deps.getShopConfig();
      const configuredMinimum =
        typeof shopConfig?.minimumOrderTotal === "number" ? shopConfig.minimumOrderTotal : 0;
      const expectedTotal = Math.max(computedTotal, configuredMinimum);

      // 1 cent tolerance for floating point drift, not a real fudge factor.
      if (Math.abs(expectedTotal - body.grandTotal) > 0.01) {
        return json({ error: "grandTotal does not match line items" }, 400);
      }

      // The client can force manual review (thresholdExceeded: true) but
      // cannot skip it — the server also checks the real threshold and
      // OR-combines the two.
      const configThreshold =
        typeof shopConfig?.customQuoteOrderThreshold === "number"
          ? shopConfig.customQuoteOrderThreshold
          : Infinity;
      const serverThresholdExceeded = Boolean(body.thresholdExceeded) ||
        body.grandTotal >= configThreshold;

      if (serverThresholdExceeded) {
        const { invoiceUrl } = await deps.createDraftOrder(body);
        return json({ mode: "draft-order", invoiceUrl });
      }

      const totalTitle = body.lineItems.map((li) => li.title).join(", ").slice(0, 250);
      const { variantId } = await deps.createPricedVariant({
        title: totalTitle || "Custom 3D Print",
        price: body.grandTotal.toFixed(2),
      });

      // v1 limitation: a single variant/cart-line is created for the whole
      // order, so only the first line item's properties (file ids, notes,
      // etc.) can travel with it — see docs/superpowers/plans/2026-08-02-shopify-integration.md.
      const properties: Record<string, string> = {};
      for (const p of body.lineItems[0]?.properties ?? []) {
        properties[p.name] = p.value;
      }

      return json({ mode: "cart", variantId, properties });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    if (err instanceof BadJsonError) {
      return json({ error: "Malformed JSON request body" }, 400);
    }
    // Don't leak internal details (shopifyGraphQL errors embed raw Shopify
    // response text) to the browser — log server-side, return a generic 500.
    console.error("shopify-relay: unhandled error", err);
    return json({ error: "Internal error" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
