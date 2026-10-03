// supabase/functions/shopify-relay/verify.test.ts
import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import {
  parseExtras,
  summariseOutcome,
  verifyOrderPricing,
  type DownloadedObject,
} from "./verify.ts";
import type { StoredMeasurement } from "./measurements.ts";
import { DEFAULT_PRICING_CONFIG } from "./pricingConfig.ts";
import type { QuoteLineItem } from "./draftOrder.ts";

const CFG = DEFAULT_PRICING_CONFIG;

// ---- Fixtures ----------------------------------------------------------

function boxTriangles(a: number, b: number, c: number): number[][] {
  const p000 = [0, 0, 0], p100 = [a, 0, 0], p110 = [a, b, 0], p010 = [0, b, 0];
  const p001 = [0, 0, c], p101 = [a, 0, c], p111 = [a, b, c], p011 = [0, b, c];
  return [
    [p000, p110, p100], [p000, p010, p110],
    [p001, p101, p111], [p001, p111, p011],
    [p000, p100, p101], [p000, p101, p001],
    [p010, p011, p111], [p010, p111, p110],
    [p000, p001, p011], [p000, p011, p010],
    [p100, p110, p111], [p100, p111, p101],
  ].map((t) => t.flat());
}

function binaryStl(triangles: number[][]): Uint8Array {
  const buf = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, triangles.length, true);
  let o = 84;
  for (const tri of triangles) {
    o += 12;
    for (const v of tri) {
      view.setFloat32(o, v, true);
      o += 4;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

/** A 20 mm cube as the measurement cache would hold it: 8 mL, 20x20x20. */
function cubeMeasurement(path: string): StoredMeasurement {
  return {
    path,
    volumeMl: 8,
    dimensions: { x: 20, y: 20, z: 20 },
    sizeBytes: 684,
    triangleCount: 12,
    measuredAt: "2026-10-03T18:00:00Z",
    error: null,
  };
}

function pathFor(model: number, part = 0): string {
  return `AF-TEST-0001/Model-${model}/part${part}.stl`;
}

/** Storage stub, used only by the inline fallback. Counts its calls so a test
 *  can assert how much parsing a request actually did. */
function cubeStore(opts: { fail?: boolean; size?: number | null } = {}) {
  const bytes = binaryStl(boxTriangles(20, 20, 20));
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    downloadObject(_path: string): Promise<DownloadedObject> {
      calls++;
      if (opts.fail) return Promise.reject(new Error("storage GET 404"));
      return Promise.resolve({
        stream: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        size: opts.size === undefined ? bytes.length : opts.size,
      });
    },
  };
}

function cache(entries: StoredMeasurement[]) {
  const map = new Map(entries.map((e) => [e.path, e]));
  let lookups = 0;
  let lastPaths: string[] = [];
  return {
    get lookups() {
      return lookups;
    },
    get lastPaths() {
      return lastPaths;
    },
    lookupMeasurements(paths: string[]) {
      lookups++;
      lastPaths = paths;
      return Promise.resolve(
        new Map(paths.filter((p) => map.has(p)).map((p) => [p, map.get(p)!])),
      );
    },
  };
}

interface FileOverrides {
  scale?: number;
  quantity?: number;
  materialId?: string;
  presupported?: boolean;
  path?: string | null;
  omitSettings?: boolean;
}

function lineItem(
  price: string,
  opts: { model?: number; files?: FileOverrides[]; extras?: string } = {},
): QuoteLineItem {
  const model = opts.model ?? 1;
  const files = opts.files ?? [{}];
  return {
    title: `Model ${model}`,
    price,
    quantity: 1,
    properties: [
      { name: "_quote_ref", value: "AF-TEST-0001" },
      { name: "_model_name", value: `Model ${model}` },
      { name: "_print_method", value: "resin" },
      { name: "_primer", value: "unprimed" },
      { name: "_assembly", value: "false" },
      { name: "_extras", value: opts.extras ?? "[]" },
      {
        name: "_files_json",
        value: JSON.stringify(files.map((f, i) => {
          const base: Record<string, unknown> = {
            filename: `part${i}.stl`,
            path: f.path === undefined ? pathFor(model, i) : f.path,
            quantity: f.quantity ?? 1,
          };
          if (!f.omitSettings) {
            base.scale = f.scale ?? 1;
            base.presupported = f.presupported ?? false;
            base.materialId = f.materialId ?? "standard";
          }
          return base;
        })),
      },
    ],
  };
}

// A 20 mm cube, standard resin, not pre-supported: Small tier £3 + 40% support
// handling = £4.20. The whole-order minimum then floors the order at £5.00 —
// exactly how submitOrder() in js/main.js builds its grandTotal.
const HONEST_MODEL_PRICE = "4.20";
const HONEST_GRAND_TOTAL = 5.00;

// ---- Pricing from the measurement cache --------------------------------

Deno.test("an honest order verifies from cached measurements, parsing nothing", async () => {
  const c = cache([cubeMeasurement(pathFor(1))]);
  const store = cubeStore();
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE)],
    HONEST_GRAND_TOTAL,
    CFG,
    { ...c, ...store },
  );
  assertEquals(out.status, "verified");
  assertEquals(out.models[0].serverPrice, 4.2);
  assertEquals(out.serverTotal, 5);
  assertEquals(out.filesFromCache, 1);
  assertEquals(out.filesMeasuredInline, 0);
  assertEquals(store.calls, 0, "must not download when the cache has it");
  assertEquals(c.lookups, 1, "one round trip for the whole order");
});

Deno.test("the attack from the audit is caught: a real model claimed at the floor", async () => {
  const c = cache([cubeMeasurement(pathFor(1))]);
  const out = await verifyOrderPricing(
    [lineItem("1.00")],
    1.00,
    CFG,
    { ...c, ...cubeStore() },
  );
  assertEquals(out.status, "mismatch");
  assertEquals(out.models[0].clientPrice, 1);
  assertEquals(out.models[0].serverPrice, 4.2);
});

Deno.test("a tampered scale is caught", async () => {
  const c = cache([cubeMeasurement(pathFor(1))]);
  // scale 3 is a 60 mm cube: inflates to 64.8 for tier lookup, lands in
  // Medium (£9 + 40% = £12.60), but is priced as the scale-1 model.
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE, { files: [{ scale: 3 }] })],
    HONEST_GRAND_TOTAL,
    CFG,
    { ...c, ...cubeStore() },
  );
  assertEquals(out.status, "mismatch");
  assertEquals(out.models[0].serverPrice, 12.6);
});

Deno.test("quantity is re-multiplied server-side", async () => {
  const c = cache([cubeMeasurement(pathFor(1))]);
  const out = await verifyOrderPricing(
    [lineItem("8.40", { files: [{ quantity: 2 }] })],
    8.40,
    CFG,
    { ...c, ...cubeStore() },
  );
  assertEquals(out.status, "verified");
  assertEquals(out.models[0].serverPrice, 8.4);
});

Deno.test("extras are included in the re-priced total", async () => {
  const c = cache([cubeMeasurement(pathFor(1))]);
  // 4.20 + wings 3.00 = 7.20
  const out = await verifyOrderPricing(
    [lineItem("7.20", { extras: JSON.stringify(["wings"]) })],
    7.20,
    CFG,
    { ...c, ...cubeStore() },
  );
  assertEquals(out.status, "verified");
  assertEquals(out.models[0].serverPrice, 7.2);
});

Deno.test("an eight-model order verifies entirely from cache", async () => {
  const models = [1, 2, 3, 4, 5, 6, 7, 8];
  const c = cache(models.map((m) => cubeMeasurement(pathFor(m))));
  const store = cubeStore();
  const out = await verifyOrderPricing(
    models.map((m) => lineItem(HONEST_MODEL_PRICE, { model: m })),
    33.60,
    CFG,
    { ...c, ...store },
  );
  assertEquals(out.status, "verified");
  assertEquals(out.serverTotal, 33.6);
  assertEquals(out.filesFromCache, 8);
  assertEquals(store.calls, 0);
  assertEquals(c.lookups, 1);
});

// ---- The regression this restructuring exists for ----------------------

Deno.test("REGRESSION: a big basket with an empty cache parses at most one file", async () => {
  // This is the bug that shipped. Measuring every file inside the checkout
  // request exhausted the edge worker's CPU budget on an eight-model basket
  // and the request died with no response, so add-to-cart did nothing at all.
  // However cold the cache, this request must now do a bounded amount of work.
  const models = [1, 2, 3, 4, 5, 6, 7, 8];
  const c = cache([]); // nothing measured yet
  const store = cubeStore();
  const out = await verifyOrderPricing(
    models.map((m) => lineItem(HONEST_MODEL_PRICE, { model: m })),
    33.60,
    CFG,
    { ...c, ...store },
  );
  assertEquals(out.status, "skipped");
  assertEquals(
    store.calls,
    1,
    "must never parse a whole basket inside one checkout",
  );
  assertEquals(out.filesMeasuredInline, 1);
});

Deno.test("the inline budget is configurable but still bounded", async () => {
  const models = [1, 2, 3, 4, 5];
  const c = cache([]);
  const store = cubeStore();
  await verifyOrderPricing(
    models.map((m) => lineItem(HONEST_MODEL_PRICE, { model: m })),
    21.00,
    CFG,
    { ...c, ...store, maxInlineFiles: 2 },
  );
  assertEquals(store.calls, 2);
});

// ---- The inline fallback ------------------------------------------------

Deno.test("a single model whose measurement has not landed is measured inline", async () => {
  const c = cache([]);
  const store = cubeStore();
  const saved: string[] = [];
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE)],
    HONEST_GRAND_TOTAL,
    CFG,
    {
      ...c,
      ...store,
      saveMeasurement: (path) => {
        saved.push(path);
        return Promise.resolve();
      },
    },
  );
  assertEquals(out.status, "verified");
  assertEquals(out.models[0].serverPrice, 4.2);
  assertEquals(out.filesMeasuredInline, 1);
  assertEquals(store.calls, 1);
  assertEquals(saved, [pathFor(1)], "inline result is cached for next time");
});

Deno.test("a file already recorded as unreadable is not retried inline", async () => {
  const broken: StoredMeasurement = {
    ...cubeMeasurement(pathFor(1)),
    measuredAt: null,
    error: "STL truncated: header declares 900 triangles, read 12",
  };
  const c = cache([broken]);
  const store = cubeStore();
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE)],
    HONEST_GRAND_TOTAL,
    CFG,
    { ...c, ...store },
  );
  assertEquals(out.status, "skipped");
  assertStringIncludes(out.reason ?? "", "could not be measured");
  assertStringIncludes(out.reason ?? "", "truncated");
  assertEquals(store.calls, 0, "no point parsing a file known to be bad");
});

Deno.test("with no fallback available, a missing measurement is skipped", async () => {
  const c = cache([]);
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE)],
    HONEST_GRAND_TOTAL,
    CFG,
    { ...c },
  );
  assertEquals(out.status, "skipped");
  assertStringIncludes(out.reason ?? "", "awaiting measurement");
});

Deno.test("a storage failure during fallback is skipped, never thrown", async () => {
  const c = cache([]);
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE)],
    HONEST_GRAND_TOTAL,
    CFG,
    { ...c, ...cubeStore({ fail: true }) },
  );
  assertEquals(out.status, "skipped");
  assertStringIncludes(out.reason ?? "", "could not fetch file");
});

Deno.test("a file too large to measure inline is skipped, not streamed", async () => {
  const c = cache([]);
  const store = cubeStore({ size: 999_999_999 });
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE)],
    HONEST_GRAND_TOTAL,
    CFG,
    { ...c, ...store, maxBytes: 1024 },
  );
  assertEquals(out.status, "skipped");
  assertStringIncludes(out.reason ?? "", "too large");
});

// ---- Unverifiable before any I/O ---------------------------------------

Deno.test("an older frontend that sends no per-file settings is skipped before any lookup", async () => {
  const c = cache([cubeMeasurement(pathFor(1))]);
  const store = cubeStore();
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE, { files: [{ omitSettings: true }] })],
    HONEST_GRAND_TOTAL,
    CFG,
    { ...c, ...store },
  );
  assertEquals(out.status, "skipped");
  assertStringIncludes(out.reason ?? "", "per-file settings");
  assertEquals(store.calls, 0);
  assertEquals(c.lastPaths, [], "nothing to look up for an unverifiable model");
});

Deno.test("a file with no storage path is skipped", async () => {
  const c = cache([]);
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE, { files: [{ path: null }] })],
    HONEST_GRAND_TOTAL,
    CFG,
    { ...c, ...cubeStore() },
  );
  assertEquals(out.status, "skipped");
  assertStringIncludes(out.reason ?? "", "no storage path");
});

Deno.test("one bad model makes the whole order unverifiable", async () => {
  const c = cache([cubeMeasurement(pathFor(1))]);
  const out = await verifyOrderPricing(
    [
      lineItem(HONEST_MODEL_PRICE, { model: 1 }),
      lineItem(HONEST_MODEL_PRICE, { model: 2, files: [{ omitSettings: true }] }),
    ],
    8.40,
    CFG,
    { ...c, ...cubeStore() },
  );
  assertEquals(out.status, "skipped");
  assertEquals(out.serverTotal, null);
});

// ---- Helpers ------------------------------------------------------------

Deno.test("parseExtras accepts a JSON array or a comma list", () => {
  assertEquals(parseExtras(""), []);
  assertEquals(parseExtras('["wings","shield"]'), ["wings", "shield"]);
  assertEquals(parseExtras("wings, shield"), ["wings", "shield"]);
});

Deno.test("the log line carries the numbers you would grep for", () => {
  const line = summariseOutcome({
    status: "mismatch",
    clientTotal: 1,
    serverTotal: 4.2,
    models: [{ title: "Model 1", clientPrice: 1, serverPrice: 4.2 }],
    filesFromCache: 1,
    filesMeasuredInline: 0,
  });
  assertStringIncludes(line, "status=mismatch");
  assertStringIncludes(line, "cached=1");
  assertStringIncludes(line, "inline=0");
  assertStringIncludes(line, "client=1.00");
  assertStringIncludes(line, "server=4.20");
  assertStringIncludes(line, "Model 1:1.00->4.20");
});
