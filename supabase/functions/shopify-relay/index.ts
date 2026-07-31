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
    const { config } = await req.json();
    await deps.saveShopConfig(config);
    return json({ ok: true });
  }

  if (url.pathname.endsWith("/files") && req.method === "POST") {
    const { filename, mimeType, base64Data } = await req.json();
    const file = await deps.uploadFile({ filename, mimeType, base64Data });
    return json(file);
  }

  if (url.pathname.endsWith("/checkout") && req.method === "POST") {
    const body = await req.json() as {
      customerEmail: string;
      customerName: string;
      grandTotal: number;
      thresholdExceeded: boolean;
      lineItems: QuoteLineItem[];
    };

    if (body.thresholdExceeded) {
      const { invoiceUrl } = await deps.createDraftOrder(body);
      return json({ mode: "draft-order", invoiceUrl });
    }

    const totalTitle = body.lineItems.map((li) => li.title).join(", ").slice(0, 250);
    const { variantId } = await deps.createPricedVariant({
      title: totalTitle || "Custom 3D Print",
      price: body.grandTotal.toFixed(2),
    });
    return json({ mode: "cart", variantId });
  }

  return json({ error: "Not found" }, 404);
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
