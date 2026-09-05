// supabase/functions/shopify-relay/index.ts
import { getShopConfig, saveShopConfig } from "./config.ts";
import { stageUpload, writeManifest } from "./files.ts";
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

// Fallbacks for when the shop has no saved pricing config metafield yet.
// These MUST mirror DEFAULT_CONFIG in js/config.js, because the browser falls
// back to those same numbers — and if the two sides disagree the relay
// rejects perfectly ordinary orders. That is exactly what happened with the
// whole-order minimum: the browser floored a £2.80 order up to £5.00 while
// the relay, defaulting to no minimum at all, expected £2.80 and refused
// every order below the floor.
const DEFAULT_MINIMUM_ORDER_TOTAL = 5.00;
const DEFAULT_CUSTOM_QUOTE_THRESHOLD = 150.00;

// The per-line rounding tolerance below has to be capped, and the number of
// lines bounded. Scaling it per line without a ceiling let a crafted request
// pad itself with hundreds of zero-priced lines until the allowed error
// exceeded the entire order value — 600 lines bought a £0.01 variant. The
// browser now derives its total from the same rounded prices it sends, so
// real orders need almost no tolerance at all.
const MAX_TOTAL_TOLERANCE = 0.10;
const MAX_LINE_ITEMS = 50;

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
 * Human-readable per-model breakdown for the order's note — the shop owner
 * reviewing this in Admin needs print method, primer, assembly, and notes at
 * a glance, plus every uploaded file with a clickable link, without having to
 * decode each line item's raw custom-attribute JSON.
 *
 * Used by both checkout paths. It used to serve only the draft-order (£150+)
 * path, which is exactly why the ordinary path lost files silently: nothing
 * ever wrote the other models down anywhere.
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

/** Shopify's order note is a bounded field, and a big multi-part order can
 *  run long. Truncate on a line boundary and say where the rest lives rather
 *  than letting Shopify silently cut it — or reject the write. */
const MAX_NOTE_CHARS = 4800;

export function capNote(note: string, manifestUrl: string | null): string {
  if (note.length <= MAX_NOTE_CHARS) return note;
  const tail = manifestUrl
    ? `\n… list truncated. Full record: ${manifestUrl}`
    : "\n… list truncated — see the line item's _models_json property.";
  const body = note.slice(0, MAX_NOTE_CHARS - tail.length);
  return body.slice(0, body.lastIndexOf("\n") + 1 || body.length) + tail;
}

interface ManifestFile {
  filename: string;
  label: string | null;
  path: string | null;
  fileUrl: string | null;
  thumbnailUrl: string | null;
  quantity: number;
}

interface ManifestModel {
  name: string;
  printMethod: string;
  primer: string;
  assembly: boolean;
  notes: string;
  price: string;
  files: ManifestFile[];
}

/** Re-reads the flat per-line-item properties the browser sends back into
 *  one structured record per model. */
export function parseModels(lineItems: QuoteLineItem[]): ManifestModel[] {
  return lineItems.map((li) => {
    const get = (name: string) => li.properties.find((p) => p.name === name)?.value ?? "";
    let files: ManifestFile[] = [];
    try {
      const parsed = JSON.parse(get("_files_json"));
      if (Array.isArray(parsed)) {
        files = parsed.map((f) => ({
          filename: String(f?.filename ?? ""),
          label: f?.label ?? null,
          path: f?.path ?? pathFromPublicUrl(f?.fileUrl ?? null),
          fileUrl: f?.fileUrl ?? null,
          thumbnailUrl: f?.thumbnailUrl ?? null,
          quantity: Number(f?.quantity) || 1,
        }));
      }
    } catch {
      files = [];
    }
    return {
      name: get("_model_name") || li.title,
      printMethod: get("_print_method"),
      primer: get("_primer"),
      assembly: get("_assembly") === "true",
      notes: get("_notes"),
      price: String(li.price ?? ""),
      files,
    };
  });
}

/** Older cached copies of the frontend send only the full public URL, not the
 *  bucket-relative path. Recover the path so the compact record the cart
 *  carries is the same shape either way. */
export function pathFromPublicUrl(url: string | null): string | null {
  if (!url) return null;
  const marker = "/object/public/quote-uploads/";
  const at = url.indexOf(marker);
  if (at === -1) return null;
  try {
    return decodeURIComponent(url.slice(at + marker.length));
  } catch {
    return url.slice(at + marker.length);
  }
}

/** The record that rides on the cart line. Deliberately compact: paths, not
 *  full URLs, so a 20-part order doesn't push the property past whatever
 *  length Shopify is willing to carry. The full version — URLs and all —
 *  goes to the manifest in the quote's own storage folder. */
export function compactModels(models: ManifestModel[]) {
  return models.map((m) => ({
    name: m.name,
    method: m.printMethod,
    primer: m.primer,
    assembly: m.assembly,
    notes: m.notes,
    files: m.files.map((f) => ({
      filename: f.filename,
      label: f.label,
      path: f.path,
      qty: f.quantity,
    })),
  }));
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
  writeManifest: typeof writeManifest;
  createPricedVariant: typeof createPricedVariant;
  createDraftOrder: typeof createDraftOrder;
  findOrCreateCustomer: typeof findOrCreateCustomer;
  sendQuoteNotification: typeof sendQuoteNotification;
}

const defaultDeps: RelayDeps = {
  getShopConfig,
  saveShopConfig,
  stageUpload,
  writeManifest,
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
      const { filename, mimeType, fileSize, quoteRef, modelName } = await readJsonBody(req);
      // quoteRef/modelName decide the storage folder. They are optional so an
      // older cached copy of the frontend keeps working (it lands under
      // unlinked/<date>/ instead) — see buildObjectPath.
      const target = await deps.stageUpload({ filename, mimeType, fileSize, quoteRef, modelName });
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
        return json({ error: "Invalid grandTotal", received: body.grandTotal }, 400);
      }
      if (!Array.isArray(body.lineItems) || body.lineItems.length === 0) {
        return json({ error: "Invalid lineItems", received: body.lineItems }, 400);
      }
      if (body.lineItems.length > MAX_LINE_ITEMS) {
        return json({
          error: "Too many line items",
          lineCount: body.lineItems.length,
          max: MAX_LINE_ITEMS,
        }, 400);
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
        typeof shopConfig?.minimumOrderTotal === "number"
          ? shopConfig.minimumOrderTotal
          : DEFAULT_MINIMUM_ORDER_TOTAL;
      const expectedTotal = Math.max(computedTotal, configuredMinimum);

      // Each line item's price arrives already rounded to the penny, while the
      // client totals the unrounded per-model figures — so the two legitimately
      // disagree by up to half a penny per line. A flat 1p tolerance therefore
      // rejected honest orders once they had three or more models, which
      // surfaced to the customer as a bare "something went wrong". Scale with
      // the line count instead; still far too tight to let tampering through,
      // since altering a price moves the total by whole pennies at least.
      const tolerance = Math.min(
        0.01 * Math.max(1, body.lineItems.length),
        MAX_TOTAL_TOLERANCE,
      );
      if (Math.abs(expectedTotal - body.grandTotal) > tolerance) {
        // Include the numbers. These are the customer's own figures, not
        // secrets, and without them a rejection reaches the browser as an
        // unexplained "something went wrong" that can only be diagnosed by
        // reproducing the exact basket — which cost days on this integration.
        return json({
          error: "grandTotal does not match line items",
          expected: Number(expectedTotal.toFixed(2)),
          received: body.grandTotal,
          lineCount: body.lineItems.length,
          tolerance: Number(tolerance.toFixed(2)),
        }, 400);
      }

      // The client can force manual review (thresholdExceeded: true) but
      // cannot skip it — the server also checks the real threshold and
      // OR-combines the two.
      const configThreshold =
        typeof shopConfig?.customQuoteOrderThreshold === "number"
          ? shopConfig.customQuoteOrderThreshold
          : DEFAULT_CUSTOM_QUOTE_THRESHOLD;
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

        const manifestUrl = await deps.writeManifest(quoteRef, {
          quoteRef,
          mode: "quote",
          createdAt: new Date().toISOString(),
          customerName: body.customerName,
          customerEmail: body.customerEmail,
          grandTotal: body.grandTotal,
          models: parseModels(body.lineItems),
        });

        const { draftOrderId } = await deps.createDraftOrder({
          customerId: customer.id,
          note: capNote(note, manifestUrl),
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

      // One variant is created for the whole order (keeping the variant
      // count on PRINT_PRODUCT_ID down), so everything the shop needs has to
      // travel on that single cart line. It used to copy only
      // lineItems[0].properties, which silently dropped every model after the
      // first: order #1399 was paid for with nine models and recorded two
      // files. Now the whole basket is carried three ways —
      //   * `note`         — the human-readable listing, which the browser
      //                      appends to the cart note so it lands in the
      //                      order's Notes field, exactly like the £150+
      //                      draft-order path already did;
      //   * `_models_json` — a compact machine-readable record on the line
      //                      item (paths, not URLs, to stay well inside
      //                      whatever length Shopify will carry);
      //   * the manifest   — the full record with URLs, written into the
      //                      quote's own storage folder next to the files.
      const models = parseModels(body.lineItems);
      const manifestUrl = await deps.writeManifest(quoteRef, {
        quoteRef,
        mode: "cart",
        createdAt: new Date().toISOString(),
        customerName: body.customerName,
        customerEmail: body.customerEmail,
        grandTotal: body.grandTotal,
        variantId,
        models,
      });

      const properties: Record<string, string> = {
        _quote_ref: quoteRef,
        _model_count: String(models.length),
        _models_json: JSON.stringify(compactModels(models)),
      };
      if (manifestUrl) properties._manifest_url = manifestUrl;

      const note = capNote(
        [
          `Quote ${quoteRef} for ${body.customerName} (${body.customerEmail}).`,
          "",
          ...buildModelSummaryLines(body.lineItems),
        ].join("\n"),
        manifestUrl,
      );

      return json({ mode: "cart", variantId, properties, note });
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
