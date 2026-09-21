// supabase/functions/shopify-relay/verify.test.ts
import { assertEquals, assertStringIncludes } from "std/testing/asserts.ts";
import {
  parseExtras,
  summariseOutcome,
  verifyOrderPricing,
  type DownloadedObject,
} from "./verify.ts";
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

/** A storage stub serving one 20 mm cube for every path. */
function cubeStore(opts: { size?: number | null; fail?: boolean } = {}) {
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

interface FileOverrides {
  scale?: number;
  quantity?: number;
  materialId?: string;
  presupported?: boolean;
  path?: string | null;
  omitSettings?: boolean;
}

function lineItem(price: string, files: FileOverrides[] = [{}], extras = "[]"): QuoteLineItem {
  return {
    title: "Model 1",
    price,
    quantity: 1,
    properties: [
      { name: "_quote_ref", value: "AF-TEST-0001" },
      { name: "_model_name", value: "Model 1" },
      { name: "_print_method", value: "resin" },
      { name: "_primer", value: "unprimed" },
      { name: "_assembly", value: "false" },
      { name: "_extras", value: extras },
      {
        name: "_files_json",
        value: JSON.stringify(files.map((f, i) => {
          const base: Record<string, unknown> = {
            filename: `part${i}.stl`,
            path: f.path === undefined ? `AF-TEST-0001/Model-1/part${i}.stl` : f.path,
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

// A 20 mm cube, standard resin, not pre-supported: Small tier £3 + 40%
// support handling = £4.20. The whole-order minimum then floors the order
// at £5.00 — exactly how submitOrder() in js/main.js builds its grandTotal.
const HONEST_MODEL_PRICE = "4.20";
const HONEST_GRAND_TOTAL = 5.00;

// ---- Tests -------------------------------------------------------------

Deno.test("an honest order verifies", async () => {
  const store = cubeStore();
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE)],
    HONEST_GRAND_TOTAL,
    CFG,
    store,
  );
  assertEquals(out.status, "verified");
  assertEquals(out.models[0].serverPrice, 4.2);
  assertEquals(out.serverTotal, 5);
  assertEquals(store.calls, 1);
});

Deno.test("the attack from the audit is caught: a real model claimed at the floor", async () => {
  const store = cubeStore();
  const out = await verifyOrderPricing(
    // The crafted request: declare the cheapest possible price for a model
    // that actually measures £4.20, and a matching grandTotal so the existing
    // arithmetic check still passes.
    [lineItem("1.00")],
    1.00,
    CFG,
    store,
  );
  assertEquals(out.status, "mismatch");
  assertEquals(out.models[0].clientPrice, 1);
  assertEquals(out.models[0].serverPrice, 4.2);
});

Deno.test("a tampered scale is caught", async () => {
  const store = cubeStore();
  // Here the client asks for scale 3 — a 60 mm cube, which inflates to 64.8
  // for tier lookup and lands in Medium (£9 + 40% fee = £12.60) — but prices
  // it as if it were the scale-1 model at £4.20.
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE, [{ scale: 3 }])],
    HONEST_GRAND_TOTAL,
    CFG,
    store,
  );
  assertEquals(out.status, "mismatch");
  assertEquals(out.models[0].serverPrice, 12.6);
});

Deno.test("quantity is re-multiplied server-side", async () => {
  const store = cubeStore();
  const out = await verifyOrderPricing(
    [lineItem("8.40", [{ quantity: 2 }])],
    8.40,
    CFG,
    store,
  );
  assertEquals(out.status, "verified");
  assertEquals(out.models[0].serverPrice, 8.4);
});

Deno.test("extras are included in the re-priced total", async () => {
  const store = cubeStore();
  // 4.20 + wings 3.00 = 7.20
  const out = await verifyOrderPricing(
    [lineItem("7.20", [{}], JSON.stringify(["wings"]))],
    7.20,
    CFG,
    store,
  );
  assertEquals(out.status, "verified");
  assertEquals(out.models[0].serverPrice, 7.2);
});

Deno.test("an older frontend that sends no per-file settings is skipped, not rejected", async () => {
  const store = cubeStore();
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE, [{ omitSettings: true }])],
    HONEST_GRAND_TOTAL,
    CFG,
    store,
  );
  assertEquals(out.status, "skipped");
  assertStringIncludes(out.reason ?? "", "per-file pricing settings");
  // Nothing was fetched — the order was unverifiable before any I/O.
  assertEquals(store.calls, 0);
});

Deno.test("a file with no storage path is skipped", async () => {
  const store = cubeStore();
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE, [{ path: null }])],
    HONEST_GRAND_TOTAL,
    CFG,
    store,
  );
  assertEquals(out.status, "skipped");
  assertStringIncludes(out.reason ?? "", "no storage path");
});

Deno.test("a storage failure is skipped, never thrown", async () => {
  const store = cubeStore({ fail: true });
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE)],
    HONEST_GRAND_TOTAL,
    CFG,
    store,
  );
  assertEquals(out.status, "skipped");
  assertStringIncludes(out.reason ?? "", "could not fetch file");
});

Deno.test("a file over the ceiling is skipped before it is streamed", async () => {
  const store = cubeStore({ size: 999_999_999 });
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE)],
    HONEST_GRAND_TOTAL,
    CFG,
    { ...store, maxBytes: 1024 },
  );
  assertEquals(out.status, "skipped");
  assertStringIncludes(out.reason ?? "", "measurement ceiling");
});

Deno.test("a ceiling breach is caught even when storage declares no size", async () => {
  const store = cubeStore({ size: null });
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE)],
    HONEST_GRAND_TOTAL,
    CFG,
    { ...store, maxBytes: 100 },
  );
  assertEquals(out.status, "skipped");
  assertStringIncludes(out.reason ?? "", "ceiling");
});

Deno.test("a multi-model order verifies every model", async () => {
  const store = cubeStore();
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE), lineItem(HONEST_MODEL_PRICE)],
    8.40,
    CFG,
    store,
  );
  assertEquals(out.status, "verified");
  assertEquals(out.models.length, 2);
  assertEquals(out.serverTotal, 8.4);
  assertEquals(store.calls, 2);
});

Deno.test("one bad model makes the whole order unverifiable", async () => {
  const store = cubeStore();
  const out = await verifyOrderPricing(
    [lineItem(HONEST_MODEL_PRICE), lineItem(HONEST_MODEL_PRICE, [{ omitSettings: true }])],
    8.40,
    CFG,
    store,
  );
  assertEquals(out.status, "skipped");
  assertEquals(out.serverTotal, null);
});

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
    filesMeasured: 1,
    bytesRead: 684,
  });
  assertStringIncludes(line, "status=mismatch");
  assertStringIncludes(line, "client=1.00");
  assertStringIncludes(line, "server=4.20");
  assertStringIncludes(line, "Model 1:1.00->4.20");
});
