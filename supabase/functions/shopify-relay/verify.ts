// supabase/functions/shopify-relay/verify.ts
//
// Re-prices a submitted order from the actual uploaded geometry.
//
// The hole this closes: /checkout is public and unauthenticated, and until
// 2026-09-21 every number in it came from the browser. The relay checked that
// the submitted line prices summed to the submitted total — marking the
// customer's own homework — but had never looked at the model, so a crafted
// request could buy any model down to the order minimum. Confirmed by probe
// against the live function in August 2026; runbook section 7.
//
// What the server establishes for itself: the geometry. What remains a
// customer declaration is the print *intent* — scale, material, colour,
// primer, assembly, extras, and whether the upload is pre-supported. Those are
// choices, not facts about the file, they are all visible on the order, and
// pre-supported in particular is verifiable by eye when the file is opened.
// Declaring them is legitimate; asserting the model's size is not, and that is
// what stops here.
//
// WHERE THE MEASURING HAPPENS — this is the part that bit us.
//
// The first version measured every file right here, inside the checkout
// request. A single model was fine. An eight-model basket killed the edge
// worker outright: parsing an STL loops over every triangle in JS, the
// per-request CPU budget ran out around the third model, and the request died
// with no response at all — so the customer's add-to-cart did nothing
// whatsoever, which is a far worse failure than any mispricing.
//
// Files are now measured once as they land (the measure-stl function) and
// cached in stl_measurements. This reads those numbers. The only parsing left
// here is a deliberately tiny fallback for a file whose measurement has not
// arrived yet, hard-capped by maxInlineFiles/maxInlineBytes so that the
// worst case is one file — never a basket's worth.
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
  StlStalledError,
  StlTooLargeError,
} from "./stl.ts";
import type { StoredMeasurement } from "./measurements.ts";
import type { QuoteLineItem } from "./draftOrder.ts";

/** Ceiling for the inline fallback only. Measurement proper (measure-stl)
 *  carries its own, larger ceiling. */
export const DEFAULT_MAX_VERIFY_BYTES = 32 * 1024 * 1024;

/** How much parsing this request may do when a measurement is missing. One
 *  file is the point: enough to cover a narrowly-lost race between upload and
 *  checkout, nowhere near enough to exhaust the CPU budget. */
const DEFAULT_MAX_INLINE_FILES = 1;

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
  /** Files priced from the measurement cache. */
  filesFromCache: number;
  /** Files this request had to parse itself (should normally be 0). */
  filesMeasuredInline: number;
}

export interface DownloadedObject {
  stream: ReadableStream<Uint8Array>;
  /** Content-Length when the storage layer reported one, else null. */
  size: number | null;
}

export interface VerifyDeps {
  /** Geometry measured at upload time, keyed by storage path. */
  lookupMeasurements(paths: string[]): Promise<Map<string, StoredMeasurement>>;
  /** Optional, bounded fallback for a measurement that has not landed yet. */
  downloadObject?(path: string): Promise<DownloadedObject>;
  /** Persists an inline measurement so the next attempt is a pure lookup. */
  saveMeasurement?(
    path: string,
    m: {
      volumeMl: number;
      dimensions: { x: number; y: number; z: number };
      triangleCount: number;
      isAscii: boolean;
      bytesRead: number;
    },
  ): Promise<void>;
  maxBytes?: number;
  maxInlineFiles?: number;
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

interface ParsedModel {
  title: string;
  clientPrice: number;
  printMethod: string;
  assembly: boolean;
  primer: string;
  extras: string[];
  files: SubmittedFile[];
  /** Set when this model is unverifiable before any I/O is attempted. */
  unverifiable?: string;
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

/** Recovers the bucket-relative path from a full public URL. An older
 *  frontend sends only the URL. */
export function pathFrom(file: SubmittedFile): string | null {
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

function parseLineItem(li: QuoteLineItem): ParsedModel {
  const files = parseFiles(prop(li, "_files_json"));
  const model: ParsedModel = {
    title: li.title ?? prop(li, "_model_name"),
    clientPrice: Number(li.price) || 0,
    printMethod: prop(li, "_print_method") || "resin",
    assembly: prop(li, "_assembly") === "true",
    primer: prop(li, "_primer") || "unprimed",
    extras: parseExtras(prop(li, "_extras")),
    files,
  };
  if (files.length === 0) {
    model.unverifiable = "no files";
  } else if (!files.every(hasPricingSettings)) {
    model.unverifiable = "missing per-file settings";
  } else if (files.some((f) => pathFrom(f) === null)) {
    model.unverifiable = "file has no storage path";
  }
  return model;
}

/**
 * Re-price one submitted order.
 *
 * Never throws for data reasons: an order it cannot measure comes back as
 * "skipped" with a reason, so a storage hiccup or an old cached frontend can
 * never take checkout down. Genuine programming errors still propagate, and
 * index.ts catches those too.
 */
export async function verifyOrderPricing(
  lineItems: QuoteLineItem[],
  clientTotal: number,
  config: PricingConfig,
  deps: VerifyDeps,
): Promise<VerifyOutcome> {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_VERIFY_BYTES;
  let inlineBudget = deps.maxInlineFiles ?? DEFAULT_MAX_INLINE_FILES;

  const parsed = lineItems.map(parseLineItem);

  // One round trip for the whole order, before any pricing.
  const wantedPaths = parsed
    .filter((m) => !m.unverifiable)
    .flatMap((m) => m.files.map(pathFrom))
    .filter((p): p is string => p !== null);
  const measured = wantedPaths.length
    ? await deps.lookupMeasurements(wantedPaths)
    : new Map<string, StoredMeasurement>();

  const models: ModelVerification[] = [];
  const groupCosts: GroupCost[] = [];
  let filesFromCache = 0;
  let filesMeasuredInline = 0;
  let anySkipped = false;
  let skipReason = "";

  for (const model of parsed) {
    if (model.unverifiable) {
      anySkipped = true;
      skipReason ||= model.unverifiable;
      models.push({
        title: model.title,
        clientPrice: model.clientPrice,
        serverPrice: null,
        skippedReason: model.unverifiable,
      });
      continue;
    }

    const items: GroupItem[] = [];
    let modelSkip = "";

    for (const file of model.files) {
      const path = pathFrom(file)!;
      const stored = measured.get(path);

      let geometry: { dimensions: { x: number; y: number; z: number }; volumeMl: number } | null =
        null;

      if (stored?.measuredAt) {
        geometry = { dimensions: stored.dimensions, volumeMl: stored.volumeMl };
        filesFromCache++;
      } else if (stored?.error) {
        // Measured and genuinely unreadable — no point parsing it again here.
        modelSkip = `file could not be measured: ${stored.error}`;
        break;
      } else if (inlineBudget > 0 && deps.downloadObject) {
        // The measurement has not landed yet — most likely a checkout that
        // beat the upload trigger. Measure this one file and nothing more.
        inlineBudget--;
        try {
          const { stream, size } = await deps.downloadObject(path);
          if (size !== null && size > maxBytes) {
            try {
              await stream.cancel();
            } catch { /* already closed */ }
            modelSkip = "awaiting measurement (file too large to measure inline)";
            break;
          }
          // Much tighter deadlines than measure-stl uses: a customer is
          // waiting on this response, and a file that cannot be read quickly
          // should become "unverifiable" (manual review) rather than hold
          // checkout open. A stalled stream here used to hang the request
          // until the platform killed it, returning nothing at all.
          const m = await measureStlStream(stream, {
            maxBytes,
            stallMs: 5_000,
            totalMs: 15_000,
          });
          filesMeasuredInline++;
          geometry = { dimensions: m.dimensions, volumeMl: m.volumeMl };
          // Cache it so a retry of this basket is a pure lookup.
          if (deps.saveMeasurement) await deps.saveMeasurement(path, m);
        } catch (err) {
          if (err instanceof StlStalledError) {
            modelSkip = "storage read too slow to measure inline — awaiting measurement";
          } else if (err instanceof StlTooLargeError) {
            modelSkip = "awaiting measurement (file over the inline ceiling)";
          } else if (err instanceof InvalidStlError) {
            modelSkip = `unreadable STL: ${err.message}`;
          } else {
            modelSkip = `could not fetch file: ${
              err instanceof Error ? err.message : String(err)
            }`;
          }
          break;
        }
      } else {
        modelSkip = "awaiting measurement";
        break;
      }

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
        cost: calcItemCost(geometry!, settings, config, model.printMethod),
      });
    }

    if (modelSkip) {
      anySkipped = true;
      skipReason ||= modelSkip;
      models.push({
        title: model.title,
        clientPrice: model.clientPrice,
        serverPrice: null,
        skippedReason: modelSkip,
      });
      continue;
    }

    const groupCost = calcGroupCost(items, {
      assembly: model.assembly,
      primer: model.primer,
      extras: model.extras,
      printMethod: model.printMethod,
    }, config);

    groupCosts.push(groupCost);
    models.push({
      title: model.title,
      clientPrice: model.clientPrice,
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
      filesFromCache,
      filesMeasuredInline,
    };
  }

  // Total the rounded per-model prices, exactly as submitOrder() in js/main.js
  // does, then apply the whole-order minimum — the client's grandTotal is
  // built the same way, so the two are directly comparable.
  const priced = models.map((m) => m.serverPrice ?? 0);
  const roundedSubtotal = priced.reduce((s, p) => s + p, 0);
  const serverTotalRaw = calcOrderTotal(
    groupCosts.map((g, i) => ({ ...g, groupTotal: priced[i] })),
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
    filesFromCache,
    filesMeasuredInline,
  };
}

/** One-line summary for the function log — the thing you grep when an order
 *  looks wrong. Deliberately compact and free of customer detail. */
export function summariseOutcome(outcome: VerifyOutcome): string {
  const head = `price-verify status=${outcome.status} ` +
    `cached=${outcome.filesFromCache} inline=${outcome.filesMeasuredInline} ` +
    `client=${outcome.clientTotal.toFixed(2)} ` +
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
