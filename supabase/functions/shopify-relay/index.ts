// supabase/functions/shopify-relay/index.ts
import { getShopConfig, saveShopConfig } from "./config.ts";
import { stageUpload } from "./files.ts";
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

const PRIMER_LABELS: Record<string, string> = {
  unprimed: "Unprimed",
  black: "Black Primer",
  grey: "Grey Primer",
  white: "White Primer",
};

const PRINT_METHOD_LABELS: Record<string, string> = {
  resin: "Resin",
  pla: "PLA",
};

/**
 * Human-readable per-model breakdown for the draft order's note — the shop
 * owner reviewing this in Admin needs print method, primer, assembly, and
 * notes at a glance, plus every uploaded file with a clickable link,
 * without having to decode each line item's raw custom-attribute JSON.
 */
function buildModelSummaryLines(lineItems: QuoteLineItem[]): string[] {
  return lineItems.flatMap((li) => {
    const get = (name: string) => li.properties.find((p) => p.name === name)?.value ?? "";

    const modelName = get("_model_name") || li.title;
    const printMethod = PRINT_METHOD_LABELS[get("_print_method")] ?? get("_print_method") ?? "—";
    const primer = PRIMER_LABELS[get("_primer")] ?? get("_primer") ?? "—";
    const assembly = get("_assembly") === "true"
      ? "Yes — assemble together"
      : "No — supply as separate parts";
    const notes = get("_notes");

    let files: Array<{ filename: string; fileUrl: string | null; quantity: number }> = [];
    try {
      files = JSON.parse(get("_files_json"));
    } catch {
      files = [];
    }

    const lines = [
      `${modelName} (${printMethod}, ${primer}):`,
      `  Assembly: ${assembly}`,
    ];
    if (notes) lines.push(`  Notes: ${notes}`);
    lines.push("  Files:");
    lines.push(...files.map((f) =>
      `    - ${f.filename} (x${f.quantity}): ${f.fileUrl ?? "(upload failed — ask the customer to resend this file)"}`
    ));
    lines.push("");
    return lines;
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
  stageUpload: typeof stageUpload;
  createPricedVariant: typeof createPricedVariant;
  createDraftOrder: typeof createDraftOrder;
  findOrCreateCustomer: typeof findOrCreateCustomer;
  sendQuoteNotification: typeof sendQuoteNotification;
}

const defaultDeps: RelayDeps = {
  getShopConfig,
  saveShopConfig,
  stageUpload,
  createPricedVariant,
  createDraftOrder,
  findOrCreateCustomer,
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

    // The browser uploads the file's actual bytes directly to the signed
    // URL this returns (Supabase Storage) — this endpoint only exchanges
    // small JSON, so it works the same regardless of file size. Unlike the
    // old Shopify-Files-based flow, the returned publicUrl is immediately
    // valid — no separate finalize/resolve round trip needed.
    if (url.pathname.endsWith("/files/stage") && req.method === "POST") {
      const { filename, mimeType, fileSize } = await readJsonBody(req);
      const target = await deps.stageUpload({ filename, mimeType, fileSize });
      return json(target);
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

      const quoteRef = extractQuoteRef(body.lineItems);

      if (serverThresholdExceeded) {
        // 1. Find-or-create the customer, with GDPR-compliant marketing consent.
        const customer = await deps.findOrCreateCustomer({
          email: body.customerEmail,
          name: body.customerName,
          marketingConsent: Boolean(body.marketingConsent),
        });

        // 2. Build the draft order — customer-linked, tagged, unsent. File
        //    URLs already arrived resolved in _files_json (Supabase Storage
        //    gives back a permanent public URL at upload time — no async
        //    resolution step needed the way Shopify Files required).
        const note = [
          `Quote ${quoteRef} for ${body.customerName} (${body.customerEmail}) — review before sending invoice.`,
          "",
          ...buildModelSummaryLines(body.lineItems),
        ].join("\n");

        const { draftOrderId } = await deps.createDraftOrder({
          customerId: customer.id,
          note,
          tags: ["quote", `quote-ref:${quoteRef}`],
          lineItems: body.lineItems,
        });

        // 3. Best-effort notify the shop owner — never blocks/fails the quote.
        await deps.sendQuoteNotification({
          quoteRef,
          customerName: body.customerName,
          customerEmail: body.customerEmail,
          grandTotal: body.grandTotal,
          draftOrderId,
        });

        return json({ mode: "quote", quoteRef, draftOrderId });
      }

      const totalTitle = body.lineItems.map((li) => li.title).join(", ").slice(0, 200);
      // Every checkout adds a new variant to PRINT_PRODUCT_ID, and the title
      // becomes that variant's option value — Shopify rejects a
      // productVariantsBulkCreate call whose option value already exists on
      // the product (e.g. two orders both left the default "Model 1" name),
      // which surfaced as a 500 on /checkout. Appending the per-order quote
      // ref (falling back to a random token on the rare empty-ref case)
      // guarantees a unique option value every time.
      const uniqueSuffix = quoteRef || crypto.randomUUID().slice(0, 8);
      const { variantId } = await deps.createPricedVariant({
        title: `${totalTitle || "Custom 3D Print"} · ${uniqueSuffix}`,
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
