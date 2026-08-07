// supabase/functions/shopify-relay/index.ts
import { getShopConfig, saveShopConfig } from "./config.ts";
import { uploadFile, resolveFileUrl } from "./files.ts";
import { createPricedVariant } from "./variant.ts";
import { createDraftOrder, type QuoteLineItem } from "./draftOrder.ts";
import { findOrCreateCustomer } from "./customer.ts";
import { sendQuoteNotification } from "./notify.ts";

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

/** One uploaded file's record as sent by the frontend in a line item's `_files_json` property. */
interface QuoteFileRecord {
  filename: string;
  fileId: string | null;
  thumbnailId: string | null;
  quantity: number;
}

/**
 * Resolves clickable download URLs for every file referenced in a line
 * item's `_files_json` property, returning a new line item with that
 * property's value replaced by the enriched (fileUrl/thumbnailUrl added)
 * JSON. Non-`_files_json` properties, and line items with no `_files_json`
 * property, pass through unchanged. A file whose URL can't be resolved
 * (still processing) gets `fileUrl: null` rather than blocking the quote.
 */
async function enrichLineItemWithFileUrls(
  lineItem: QuoteLineItem,
  resolveFileUrlFn: typeof resolveFileUrl,
): Promise<QuoteLineItem> {
  const properties = await Promise.all(lineItem.properties.map(async (p) => {
    if (p.name !== "_files_json") return p;
    let files: QuoteFileRecord[];
    try {
      files = JSON.parse(p.value);
    } catch {
      return p;
    }
    const enriched = await Promise.all(files.map(async (f) => ({
      ...f,
      fileUrl: f.fileId ? await resolveFileUrlFn(f.fileId) : null,
      thumbnailUrl: f.thumbnailId ? await resolveFileUrlFn(f.thumbnailId) : null,
    })));
    return { name: p.name, value: JSON.stringify(enriched) };
  }));
  return { ...lineItem, properties };
}

/** Human-scannable file list for the draft order's note, so the whole quote is readable without opening every line item's custom attributes. */
function buildFileSummaryLines(lineItems: QuoteLineItem[]): string[] {
  return lineItems.flatMap((li) => {
    const filesProp = li.properties.find((p) => p.name === "_files_json");
    if (!filesProp) return [];
    let files: Array<{ filename: string; fileUrl: string | null }>;
    try {
      files = JSON.parse(filesProp.value);
    } catch {
      return [];
    }
    return files.map((f) =>
      `  - ${f.filename}: ${f.fileUrl ?? "(still processing — check Shopify Files)"}`
    );
  });
}

function extractQuoteRef(lineItems: QuoteLineItem[]): string {
  return lineItems[0]?.properties.find((p) => p.name === "_quote_ref")?.value ?? "";
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
  findOrCreateCustomer: typeof findOrCreateCustomer;
  resolveFileUrl: typeof resolveFileUrl;
  sendQuoteNotification: typeof sendQuoteNotification;
}

const defaultDeps: RelayDeps = {
  getShopConfig,
  saveShopConfig,
  uploadFile,
  createPricedVariant,
  createDraftOrder,
  findOrCreateCustomer,
  resolveFileUrl,
  sendQuoteNotification,
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
        marketingConsent?: boolean;
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
        // 1. Find-or-create the customer, with GDPR-compliant marketing consent.
        const customer = await deps.findOrCreateCustomer({
          email: body.customerEmail,
          name: body.customerName,
          marketingConsent: Boolean(body.marketingConsent),
        });

        // 2. Resolve clickable file URLs for every uploaded STL/thumbnail
        //    referenced in the line items, so the draft order is
        //    self-contained for review (no need to hunt through Shopify's
        //    Files library by GID).
        const enrichedLineItems = await Promise.all(
          body.lineItems.map((li) => enrichLineItemWithFileUrls(li, deps.resolveFileUrl)),
        );

        // 3. Build the draft order — customer-linked, tagged, unsent.
        const quoteRef = extractQuoteRef(body.lineItems);
        const note = [
          `Quote ${quoteRef} for ${body.customerName} (${body.customerEmail}) — review before sending invoice.`,
          "",
          "Files:",
          ...buildFileSummaryLines(enrichedLineItems),
        ].join("\n");

        const { draftOrderId } = await deps.createDraftOrder({
          customerId: customer.id,
          note,
          tags: ["quote", `quote-ref:${quoteRef}`],
          lineItems: enrichedLineItems,
        });

        // 4. Best-effort notify the shop owner — never blocks/fails the quote.
        await deps.sendQuoteNotification({
          quoteRef,
          customerName: body.customerName,
          customerEmail: body.customerEmail,
          grandTotal: body.grandTotal,
          draftOrderId,
        });

        return json({ mode: "quote", quoteRef, draftOrderId });
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
