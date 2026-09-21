// supabase/functions/shopify-relay/verify.ts
//
// Re-prices a submitted order from the actual uploaded geometry.
//
// The hole this closes: /checkout is public and unauthenticated, and until now
// every number in it came from the browser. The relay checked that the
// submitted line prices summed to the submitted total — marking the
// customer's own homework — but had never looked at the model, so a crafted
// request could buy any model down to the order minimum. Confirmed by probe
// against the live function in August 2026; runbook section 7.
//
// What the server now establishes for itself: the geometry. Each file is
// pulled from Storage, measured (stl.ts), and run through the same pricing
// engine the browser uses (pricing.ts). What remains a customer declaration
// is the print *intent* — scale, material, colour, primer, assembly, extras,
// and whether the upload is pre-supported. Those are choices, not facts about
// the file, they are all visible on the order, and pre-supported in
// particular is verifiable by eye when the file is opened. Declaring them is
// legitimate; asserting the model's size is not, and that is what stops here.
//
// This module only ever reports. The decision about what to do with a
// mismatch lives in index.ts, behind PRICE_VERIFY_MODE.

import {
  calcGroupCost,
  calcItemCost,
  calcOrderTotal,
  type GroupCost,
  type GroupItem,
  type PricingConfig,
} from "./pricing.ts";
import {
  InvalidStlError,
  measureStlStream,
  StlTooLargeError,
} from "./stl.ts";
import type { QuoteLineItem } from "./draftOrder.ts";

/** Measurement ceiling per file. An Edge Function gets 256 MB; stl.ts streams
 *  so the high-water mark is roughly one chunk rather than a multiple of the
 *  file, but an unbounded read is still an unbounded wall clock. 64 MB sits
 *  comfortably above the bucket's own 50 MB limit, so in practice this only
 *  fires if the bucket cap is ever raised without revisiting this. */
export const DEFAULT_MAX_VERIFY_BYTES = 64 * 1024 * 1024;

/** Per-model agreement tolerance, in currency units. Both sides run identical
 *  arithmetic over identical geometry, so a real order should differ by zero;
 *  a penny absorbs float noise and nothing else. */
const MODEL_TOLERANCE = 0.011;

export type VerifyStatus = "verified" | "mismatch" | "skipped";

export interface ModelVerification {
  title: string;
  clientPrice: number;
  serverPrice: number | null;
  /** Populated when this model could not be re-priced. */
  skippedReason?: string;
}

export interface VerifyOutcome {
  status: VerifyStatus;
  /** Why the order could not be verified, when status is "skipped". */
  reason?: string;
  clientTotal: number;
  serverTotal: number | null;
  models: ModelVerification[];
  /** Files measured, for the log line. */
  filesMeasured: number;
  bytesRead: number;
}

export interface DownloadedObject {
  stream: ReadableStream<Uint8Array>;
  /** Content-Length when the storage layer reported one, else null. */
  size: number | null;
}

export interface VerifyDeps {
  downloadObject(path: string): Promise<DownloadedObject>;
  maxBytes?: number;
}

interface SubmittedFile {
  filename?: string;
  path?: string | null;
  fileUrl?: string | null;
  quantity?: number;
  // Added for server-side pricing — absent on older cached frontends.
  scale?: number;
  presupported?: boolean;
  materialId?: string;
  plaColor?: string;
}

function prop(li: QuoteLineItem, name: string): string {
  return li.properties.find((p) => p.name === name)?.value ?? "";
}

/** Extras ride as a JSON array; tolerate a comma-separated string too, since
 *  that is the cheaper thing for a future caller to send by hand. */
export function parseExtras(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* fall through to the comma form */
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseFiles(raw: string): SubmittedFile[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as SubmittedFile[] : [];
  } catch {
    return [];
  }
}

/** Recovers the bucket-relative path from a full public URL. Kept here as
 *  well as in files.ts because an older frontend sends only the URL. */
function pathFrom(file: SubmittedFile): string | null {
  if (file.path) return file.path;
  const url = file.fileUrl;
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

/** A file can only be re-priced if the browser told us how it is being
 *  printed. Older cached frontends send filename/path/quantity only. */
function hasPricingSettings(file: SubmittedFile): boolean {
  return typeof file.scale === "number" && Number.isFinite(file.scale);
}

/**
 * Re-price one submitted order.
 *
 * Never throws for data reasons: an order it cannot measure comes back as
 * "skipped" with a reason, so a storage hiccup or an old cached frontend can
 * never take checkout down. Genuine programming errors still propagate.
 */
export async function verifyOrderPricing(
  lineItems: QuoteLineItem[],
  clientTotal: number,
  config: PricingConfig,
  deps: VerifyDeps,
): Promise<VerifyOutcome> {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_VERIFY_BYTES;
  const models: ModelVerification[] = [];
  const groupCosts: GroupCost[] = [];
  let filesMeasured = 0;
  let bytesRead = 0;
  let anySkipped = false;
  let skipReason = "";

  for (const li of lineItems) {
    const title = li.title ?? prop(li, "_model_name");
    const clientPrice = Number(li.price) || 0;
    const files = parseFiles(prop(li, "_files_json"));
    const printMethod = prop(li, "_print_method") || "resin";

    if (files.length === 0) {
      anySkipped = true;
      skipReason ||= "line item carried no files";
      models.push({
        title,
        clientPrice,
        serverPrice: null,
        skippedReason: "no files",
      });
      continue;
    }
    if (!files.every(hasPricingSettings)) {
      anySkipped = true;
      skipReason ||= "frontend did not send per-file pricing settings";
      models.push({
        title,
        clientPrice,
        serverPrice: null,
        skippedReason: "missing per-file settings",
      });
      continue;
    }

    const items: GroupItem[] = [];
    let modelSkip = "";

    for (const file of files) {
      const path = pathFrom(file);
      if (!path) {
        modelSkip = "file has no storage path";
        break;
      }
      try {
        const { stream, size } = await deps.downloadObject(path);
        if (size !== null && size > maxBytes) {
          // Cancel rather than stream a file we have already decided against.
          try {
            await stream.cancel();
          } catch { /* already closed */ }
          modelSkip = `file exceeds the ${maxBytes}-byte measurement ceiling`;
          break;
        }
        const measured = await measureStlStream(stream, maxBytes);
        filesMeasured++;
        bytesRead += measured.bytesRead;

        const settings = {
          scale: file.scale ?? 1,
          quantity: Number(file.quantity) || 1,
          materialId: file.materialId,
          presupported: Boolean(file.presupported),
          plaColor: file.plaColor,
        };
        items.push({
          status: "ready",
          settings,
          cost: calcItemCost(measured, settings, config, printMethod),
        });
      } catch (err) {
        if (err instanceof StlTooLargeError) {
          modelSkip = "file exceeds the measurement ceiling";
        } else if (err instanceof InvalidStlError) {
          modelSkip = `unreadable STL: ${err.message}`;
        } else {
          modelSkip = `could not fetch file: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
        break;
      }
    }

    if (modelSkip) {
      anySkipped = true;
      skipReason ||= modelSkip;
      models.push({
        title,
        clientPrice,
        serverPrice: null,
        skippedReason: modelSkip,
      });
      continue;
    }

    const groupCost = calcGroupCost(items, {
      assembly: prop(li, "_assembly") === "true",
      primer: prop(li, "_primer") || "unprimed",
      extras: parseExtras(prop(li, "_extras")),
      printMethod,
    }, config);

    groupCosts.push(groupCost);
    models.push({
      title,
      clientPrice,
      // Round the same way the browser does before it puts the figure on the
      // wire, so the comparison is like for like.
      serverPrice: Number(groupCost.groupTotal.toFixed(2)),
    });
  }

  if (anySkipped) {
    return {
      status: "skipped",
      reason: skipReason,
      clientTotal,
      serverTotal: null,
      models,
      filesMeasured,
      bytesRead,
    };
  }

  // Total the rounded per-model prices, exactly as submitOrder() in
  // js/main.js does, then apply the whole-order minimum — the client's
  // grandTotal is built the same way, so the two are directly comparable.
  const roundedSubtotal = models.reduce((s, m) => s + (m.serverPrice ?? 0), 0);
  const serverTotalRaw = calcOrderTotal(
    groupCosts.map((g, i) => ({ ...g, groupTotal: models[i].serverPrice ?? 0 })),
    config,
  );
  const serverTotal = Number(
    (roundedSubtotal > 0 ? serverTotalRaw : roundedSubtotal).toFixed(2),
  );

  const mismatched = models.some(
    (m) => Math.abs((m.serverPrice ?? 0) - m.clientPrice) > MODEL_TOLERANCE,
  ) || Math.abs(serverTotal - clientTotal) > MODEL_TOLERANCE;

  return {
    status: mismatched ? "mismatch" : "verified",
    clientTotal,
    serverTotal,
    models,
    filesMeasured,
    bytesRead,
  };
}

/** One-line summary for the function log — the thing you grep when an order
 *  looks wrong. Deliberately compact and free of customer detail. */
export function summariseOutcome(outcome: VerifyOutcome): string {
  const head =
    `price-verify status=${outcome.status} files=${outcome.filesMeasured} ` +
    `bytes=${outcome.bytesRead} client=${outcome.clientTotal.toFixed(2)} ` +
    `server=${outcome.serverTotal === null ? "n/a" : outcome.serverTotal.toFixed(2)}`;
  if (outcome.status === "skipped") return `${head} reason="${outcome.reason}"`;
  if (outcome.status === "mismatch") {
    const worst = outcome.models
      .filter((m) => m.serverPrice !== null)
      .map((m) => `${m.title}:${m.clientPrice.toFixed(2)}->${m.serverPrice!.toFixed(2)}`)
      .join(" ");
    return `${head} models=[${worst}]`;
  }
  return head;
}
