// supabase/functions/shopify-relay/index.test.ts
import { assertEquals } from "std/testing/asserts.ts";
import { handleRequest, type RelayDeps } from "./index.ts";

// index.ts's job is routing/dispatch, not talking to Shopify directly, so
// handleRequest accepts its dependencies as a parameter (defaulting to the
// real module functions). That makes them trivially substitutable here
// without needing to mock fetch or fight Deno's non-configurable ES module
// exports (stub() on the leaf modules throws "Cannot redefine property").
function fakeDeps(overrides: Partial<RelayDeps>): RelayDeps {
  return {
    getShopConfig: () => {
      throw new Error("getShopConfig not stubbed");
    },
    saveShopConfig: () => {
      throw new Error("saveShopConfig not stubbed");
    },
    stageUpload: () => {
      throw new Error("stageUpload not stubbed");
    },
    // Defaults to a no-op rather than throwing: manifest writing is
    // best-effort by contract, and every checkout test would otherwise have
    // to stub it just to exercise something else.
    writeManifest: () => Promise.resolve(null),
    createPricedVariant: () => {
      throw new Error("createPricedVariant not stubbed");
    },
    createDraftOrder: () => {
      throw new Error("createDraftOrder not stubbed");
    },
    findOrCreateCustomer: () => {
      throw new Error("findOrCreateCustomer not stubbed");
    },
    sendQuoteNotification: () => {
      throw new Error("sendQuoteNotification not stubbed");
    },
    ...overrides,
  };
}

Deno.test("GET /config returns stored config", async () => {
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve({ minimumOrderTotal: 5 }),
  });
  const res = await handleRequest(
    new Request("https://relay.test/config", { method: "GET" }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { config: { minimumOrderTotal: 5 } });
});

Deno.test("POST /config without correct password returns 401", async () => {
  const originalPassword = Deno.env.get("ADMIN_PASSWORD");
  Deno.env.set("ADMIN_PASSWORD", "correct-horse");
  try {
    const deps = fakeDeps({});
    const res = await handleRequest(
      new Request("https://relay.test/config", {
        method: "POST",
        headers: { "x-admin-password": "wrong", "content-type": "application/json" },
        body: JSON.stringify({ config: {} }),
      }),
      deps,
    );
    assertEquals(res.status, 401);
  } finally {
    if (originalPassword === undefined) {
      Deno.env.delete("ADMIN_PASSWORD");
    } else {
      Deno.env.set("ADMIN_PASSWORD", originalPassword);
    }
  }
});

Deno.test("POST /config with correct password saves and returns ok", async () => {
  const originalPassword = Deno.env.get("ADMIN_PASSWORD");
  Deno.env.set("ADMIN_PASSWORD", "correct-horse");
  let savedConfig: unknown = null;
  try {
    const deps = fakeDeps({
      saveShopConfig: (config) => {
        savedConfig = config;
        return Promise.resolve();
      },
    });
    const res = await handleRequest(
      new Request("https://relay.test/config", {
        method: "POST",
        headers: { "x-admin-password": "correct-horse", "content-type": "application/json" },
        body: JSON.stringify({ config: { minimumOrderTotal: 10 } }),
      }),
      deps,
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true });
    assertEquals(savedConfig, { minimumOrderTotal: 10 });
  } finally {
    if (originalPassword === undefined) {
      Deno.env.delete("ADMIN_PASSWORD");
    } else {
      Deno.env.set("ADMIN_PASSWORD", originalPassword);
    }
  }
});

Deno.test("POST /files/stage forwards the quote ref and model name so the file is filed under them", async () => {
  // The folder an upload lands in is the only thing tying a stored file back
  // to its order, so these two fields have to survive the round trip.
  let seen: Record<string, unknown> | null = null;
  const deps = fakeDeps({
    stageUpload: (input) => {
      seen = input as unknown as Record<string, unknown>;
      const path = `${input.quoteRef}/${input.modelName}/${input.filename}`;
      return Promise.resolve({
        uploadUrl: `https://project-ref.supabase.co/storage/v1/object/upload/sign/quote-uploads/${path}?token=fake-token`,
        publicUrl: `https://project-ref.supabase.co/storage/v1/object/public/quote-uploads/${path}`,
        path,
      });
    },
  });
  const res = await handleRequest(
    new Request("https://relay.test/files/stage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "model.stl",
        mimeType: "model/stl",
        fileSize: 1024,
        quoteRef: "AF-1",
        modelName: "Model 3",
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(seen!.quoteRef, "AF-1");
  assertEquals(seen!.modelName, "Model 3");
  assertEquals(await res.json(), {
    uploadUrl: "https://project-ref.supabase.co/storage/v1/object/upload/sign/quote-uploads/AF-1/Model 3/model.stl?token=fake-token",
    publicUrl: "https://project-ref.supabase.co/storage/v1/object/public/quote-uploads/AF-1/Model 3/model.stl",
    path: "AF-1/Model 3/model.stl",
  });
});

Deno.test("POST /checkout below threshold carries every model, not just the first", async () => {
  // The regression this exists for: the cart path used to copy only
  // lineItems[0].properties onto the single variant, so a three-model order
  // reached Shopify recording one model's files and silently losing the rest.
  // Order #1399 was paid for with nine models and recorded two files.
  let manifested: any = null;
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    createPricedVariant: () => Promise.resolve({ variantId: 999 }),
    writeManifest: (quoteRef, manifest) => {
      manifested = { quoteRef, manifest };
      return Promise.resolve("https://p.supabase.co/storage/v1/object/public/quote-uploads/AF-9/manifest.json");
    },
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 15.00,
        thresholdExceeded: false,
        lineItems: [
          {
            title: "Model 1",
            price: "5.00",
            quantity: 1,
            properties: [
              { name: "_quote_ref", value: "AF-9" },
              { name: "_model_name", value: "Model 1" },
              { name: "_print_method", value: "resin" },
              { name: "_primer", value: "unprimed" },
              { name: "_assembly", value: "false" },
              { name: "_notes", value: "" },
              {
                name: "_files_json",
                value: JSON.stringify([{
                  filename: "part1.stl",
                  label: null,
                  path: "AF-9/Model-1/part1.stl",
                  fileUrl: "https://p.supabase.co/storage/v1/object/public/quote-uploads/AF-9/Model-1/part1.stl",
                  thumbnailUrl: null,
                  quantity: 1,
                }]),
              },
            ],
          },
          {
            title: "Model 2",
            price: "5.00",
            quantity: 1,
            properties: [
              { name: "_quote_ref", value: "AF-9" },
              { name: "_model_name", value: "Model 2" },
              { name: "_print_method", value: "resin" },
              { name: "_primer", value: "unprimed" },
              { name: "_assembly", value: "false" },
              { name: "_notes", value: "" },
              {
                name: "_files_json",
                value: JSON.stringify([{
                  filename: "part2.stl",
                  label: null,
                  path: "AF-9/Model-2/part2.stl",
                  fileUrl: "https://p.supabase.co/storage/v1/object/public/quote-uploads/AF-9/Model-2/part2.stl",
                  thumbnailUrl: null,
                  quantity: 1,
                }]),
              },
            ],
          },
          {
            title: "Model 3",
            price: "5.00",
            quantity: 1,
            properties: [
              { name: "_quote_ref", value: "AF-9" },
              { name: "_model_name", value: "Model 3" },
              { name: "_print_method", value: "resin" },
              { name: "_primer", value: "unprimed" },
              { name: "_assembly", value: "false" },
              { name: "_notes", value: "" },
              {
                name: "_files_json",
                value: JSON.stringify([{
                  filename: "part3.stl",
                  label: null,
                  path: "AF-9/Model-3/part3.stl",
                  fileUrl: "https://p.supabase.co/storage/v1/object/public/quote-uploads/AF-9/Model-3/part3.stl",
                  thumbnailUrl: null,
                  quantity: 1,
                }]),
              },
            ],
          },
        ],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  const payload = await res.json();
  assertEquals(payload.mode, "cart");
  assertEquals(payload.variantId, 999);
  assertEquals(payload.properties._quote_ref, "AF-9");
  assertEquals(payload.properties._model_count, "3");

  // Every model's file is in the compact record on the cart line...
  const carried = JSON.parse(payload.properties._models_json);
  assertEquals(carried.length, 3);
  assertEquals(
    carried.flatMap((m: any) => m.files.map((f: any) => f.filename)),
    ["part1.stl", "part2.stl", "part3.stl"],
  );
  // ...as paths rather than full URLs, so the property stays compact.
  assertEquals(carried[2].files[0].path, "AF-9/Model-3/part3.stl");

  // ...and every model's file is in the note the browser puts on the cart,
  // which is what makes them visible in the order's Notes field in Admin.
  for (const name of ["part1.stl", "part2.stl", "part3.stl"]) {
    assertEquals(payload.note.includes(name), true, `note is missing ${name}`);
  }

  // ...and the full record, URLs and all, is written beside the files.
  assertEquals(manifested.quoteRef, "AF-9");
  assertEquals(manifested.manifest.models.length, 3);
  assertEquals(
    manifested.manifest.models[1].files[0].fileUrl,
    "https://p.supabase.co/storage/v1/object/public/quote-uploads/AF-9/Model-2/part2.stl",
  );
  assertEquals(
    payload.properties._manifest_url,
    "https://p.supabase.co/storage/v1/object/public/quote-uploads/AF-9/manifest.json",
  );
});

Deno.test("POST /checkout still succeeds when the manifest cannot be written", async () => {
  // Manifest writing is best-effort: storage being unavailable must never
  // cost the customer their checkout.
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    createPricedVariant: () => Promise.resolve({ variantId: 999 }),
    writeManifest: () => Promise.resolve(null),
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 17.68,
        thresholdExceeded: false,
        lineItems: [{
          title: "Model 1",
          price: "17.68",
          quantity: 1,
          properties: [
            { name: "_quote_ref", value: "AF-1" },
            { name: "_model_name", value: "Model 1" },
          ],
        }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  const payload = await res.json();
  assertEquals(payload.mode, "cart");
  assertEquals(payload.properties._quote_ref, "AF-1");
  assertEquals("_manifest_url" in payload.properties, false);
});

Deno.test("POST /checkout above threshold creates a customer, a linked draft order, sends a notification, and returns quote mode", async () => {
  let customerCalled = false;
  let draftOrderCalled = false;
  let notificationCalled = false;
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    findOrCreateCustomer: (input) => {
      customerCalled = true;
      assertEquals(input.email, "jane@example.com");
      assertEquals(input.name, "Jane Smith");
      assertEquals(input.marketingConsent, true);
      return Promise.resolve({ id: "gid://shopify/Customer/1" });
    },
    createDraftOrder: (input) => {
      draftOrderCalled = true;
      assertEquals(input.customerId, "gid://shopify/Customer/1");
      assertEquals(input.tags.includes("quote"), true);
      return Promise.resolve({ draftOrderId: "999" });
    },
    sendQuoteNotification: (input) => {
      notificationCalled = true;
      assertEquals(input.draftOrderId, "999");
      return Promise.resolve();
    },
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        marketingConsent: true,
        grandTotal: 180,
        thresholdExceeded: true,
        lineItems: [{
          title: "Model 1",
          price: "180.00",
          quantity: 1,
          properties: [
            { name: "_quote_ref", value: "AF-20260807-XYZ" },
            {
              name: "_files_json",
              value: JSON.stringify([{
                filename: "part.stl",
                fileUrl: "https://project-ref.supabase.co/storage/v1/object/public/quote-uploads/abc/part.stl",
                thumbnailUrl: null,
                quantity: 1,
              }]),
            },
          ],
        }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    mode: "quote",
    quoteRef: "AF-20260807-XYZ",
    draftOrderId: "999",
  });
  assertEquals(customerCalled, true);
  assertEquals(draftOrderCalled, true);
  assertEquals(notificationCalled, true);
});

Deno.test("POST /checkout builds a human-readable note with print method, primer, assembly, notes, and file links", async () => {
  let capturedNote = "";
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    findOrCreateCustomer: () => Promise.resolve({ id: "gid://shopify/Customer/1" }),
    createDraftOrder: (input) => {
      capturedNote = input.note;
      return Promise.resolve({ draftOrderId: "999" });
    },
    sendQuoteNotification: () => Promise.resolve(),
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 180,
        thresholdExceeded: true,
        lineItems: [{
          title: "Model 1",
          price: "180.00",
          quantity: 1,
          properties: [
            { name: "_quote_ref", value: "AF-1" },
            { name: "_model_name", value: "Dragon Miniature" },
            { name: "_print_method", value: "resin" },
            { name: "_primer", value: "black" },
            { name: "_assembly", value: "true" },
            { name: "_notes", value: "Please paint eyes red" },
            {
              name: "_files_json",
              value: JSON.stringify([{
                filename: "dragon.stl",
                fileUrl: "https://project-ref.supabase.co/storage/v1/object/public/quote-uploads/abc/dragon.stl",
                thumbnailUrl: null,
                quantity: 2,
              }]),
            },
          ],
        }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(capturedNote.includes("Dragon Miniature (Resin, Black Primer):"), true);
  assertEquals(capturedNote.includes("Assembly: Yes — assemble together"), true);
  assertEquals(capturedNote.includes("Notes: Please paint eyes red"), true);
  assertEquals(
    capturedNote.includes(
      "dragon.stl (x2): https://project-ref.supabase.co/storage/v1/object/public/quote-uploads/abc/dragon.stl",
    ),
    true,
  );
});

Deno.test("POST /checkout still creates the quote when a file failed to upload (fileUrl null)", async () => {
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    findOrCreateCustomer: () => Promise.resolve({ id: "gid://shopify/Customer/1" }),
    createDraftOrder: () => Promise.resolve({ draftOrderId: "999" }),
    sendQuoteNotification: () => Promise.resolve(),
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 180,
        thresholdExceeded: true,
        lineItems: [{
          title: "Model 1",
          price: "180.00",
          quantity: 1,
          properties: [
            { name: "_quote_ref", value: "AF-1" },
            {
              name: "_files_json",
              value: JSON.stringify([{
                filename: "part.stl",
                fileUrl: null, // simulates a failed upload
                thumbnailUrl: null,
                quantity: 1,
              }]),
            },
          ],
        }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.mode, "quote");
});

Deno.test("POST /checkout accepts an order floored to the whole-order minimum when the shop has no saved config", async () => {
  // A shop that has never saved its pricing config returns null here, and the
  // browser falls back to DEFAULT_CONFIG's £5 minimum. The relay has to fall
  // back to the same figure, or every order under the floor is rejected.
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    createPricedVariant: () => Promise.resolve({ variantId: 999 }),
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 5.00, // floored up from the 2.80 of actual parts
        thresholdExceeded: false,
        lineItems: [{ title: "Model 1", price: "2.80", quantity: 1, properties: [] }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
});

Deno.test("POST /checkout forces manual review above the default threshold when the shop has no saved config", async () => {
  let draftOrderCalled = false;
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    findOrCreateCustomer: () => Promise.resolve({ id: "gid://shopify/Customer/1" }),
    createDraftOrder: () => {
      draftOrderCalled = true;
      return Promise.resolve({ draftOrderId: "999" });
    },
    sendQuoteNotification: () => Promise.resolve(),
    createPricedVariant: () => Promise.resolve({ variantId: 999 }),
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 200,
        thresholdExceeded: false, // client tries to skip manual review
        lineItems: [{ title: "Model 1", price: "200.00", quantity: 1, properties: [] }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(draftOrderCalled, true);
});

Deno.test("POST /checkout accepts a multi-model order whose per-line penny rounding drifts past a flat 1p", async () => {
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    createPricedVariant: () => Promise.resolve({ variantId: 999 }),
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        // Three models, each rounded down by just under half a penny when sent
        // as a line item, so the client's unrounded total sits 0.0149 above
        // the sum of the prices — beyond the old flat 1p tolerance.
        grandTotal: 25.2149,
        thresholdExceeded: false,
        lineItems: [
          { title: "Model 1", price: "8.40", quantity: 1, properties: [] },
          { title: "Model 2", price: "8.40", quantity: 1, properties: [] },
          { title: "Model 3", price: "8.40", quantity: 1, properties: [] },
        ],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
});

Deno.test("POST /checkout rejects a payload padded with lines to inflate the rounding tolerance", async () => {
  // Tolerance used to scale 1p per line with no ceiling, so ~600 zero-priced
  // padding lines made the allowed error exceed the whole order and bought a
  // £0.01 variant. Both the cap and the line limit must hold this shut.
  let variantCalled = false;
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    createPricedVariant: () => {
      variantCalled = true;
      return Promise.resolve({ variantId: 999 });
    },
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "attacker@example.com",
        customerName: "Attacker",
        grandTotal: 0.01,
        thresholdExceeded: false,
        lineItems: Array.from({ length: 600 }, () => ({
          title: "pad",
          price: "0.00",
          quantity: 1,
          properties: [],
        })),
      }),
    }),
    deps,
  );
  assertEquals(res.status, 400);
  assertEquals(variantCalled, false);
});

Deno.test("POST /checkout caps the rounding tolerance well below a penny per line at scale", async () => {
  // 50 lines would once have allowed 50p of drift; the cap holds it to 10p.
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    createPricedVariant: () => Promise.resolve({ variantId: 999 }),
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "attacker@example.com",
        customerName: "Attacker",
        // 50 lines at £1 = £50; shaving 30p is inside the old 50p allowance
        // but outside the 10p cap.
        grandTotal: 49.70,
        thresholdExceeded: false,
        lineItems: Array.from({ length: 50 }, () => ({
          title: "m",
          price: "1.00",
          quantity: 1,
          properties: [],
        })),
      }),
    }),
    deps,
  );
  assertEquals(res.status, 400);
});

Deno.test("POST /checkout still rejects a tampered grandTotal on a multi-model order", async () => {
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    createPricedVariant: () => Promise.resolve({ variantId: 999 }),
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 1.00, // real line total is 25.20
        thresholdExceeded: false,
        lineItems: [
          { title: "Model 1", price: "8.40", quantity: 1, properties: [] },
          { title: "Model 2", price: "8.40", quantity: 1, properties: [] },
          { title: "Model 3", price: "8.40", quantity: 1, properties: [] },
        ],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 400);
});

Deno.test("POST /checkout rejects a grandTotal that doesn't match the line items' price*quantity", async () => {
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    createPricedVariant: () => Promise.resolve({ variantId: 999 }),
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 0.01, // tampered — real line item total is 180.00
        thresholdExceeded: false,
        lineItems: [{ title: "Model 1", price: "180.00", quantity: 1, properties: [] }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 400);
});

Deno.test("POST /checkout accepts a grandTotal bumped up to the configured minimumOrderTotal", async () => {
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve({ minimumOrderTotal: 5 }),
    createPricedVariant: () => Promise.resolve({ variantId: 999 }),
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        // Raw line item total is 3.20, but the frontend bumps grandTotal up
        // to the configured whole-order minimum (5.00) before submitting.
        grandTotal: 5.00,
        thresholdExceeded: false,
        lineItems: [{ title: "Tiny Model", price: "3.20", quantity: 1, properties: [] }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  const payload = await res.json();
  assertEquals(payload.mode, "cart");
  assertEquals(payload.variantId, 999);
  assertEquals(payload.properties._model_count, "1");
});

Deno.test("POST /checkout appends the quote ref to the priced variant's title so repeat default model names (e.g. 'Model 1') never collide as Shopify option values", async () => {
  let capturedTitle: string | undefined;
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    createPricedVariant: (input) => {
      capturedTitle = input.title;
      return Promise.resolve({ variantId: 999 });
    },
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 8.40,
        thresholdExceeded: false,
        lineItems: [{
          title: "Model 1",
          price: "8.40",
          quantity: 1,
          properties: [{ name: "_quote_ref", value: "AF-20260814-H2JP" }],
        }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(capturedTitle, "Model 1 · AF-20260814-H2JP");
});

Deno.test("POST /checkout forces a draft order server-side when grandTotal exceeds the configured threshold, even if thresholdExceeded is false", async () => {
  let draftOrderCalled = false;
  let variantCalled = false;
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve({ customQuoteOrderThreshold: 150 }),
    findOrCreateCustomer: () => Promise.resolve({ id: "gid://shopify/Customer/1" }),
    createDraftOrder: () => {
      draftOrderCalled = true;
      return Promise.resolve({ draftOrderId: "999" });
    },
    sendQuoteNotification: () => Promise.resolve(),
    createPricedVariant: () => {
      variantCalled = true;
      return Promise.resolve({ variantId: 999 });
    },
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 200, // over the configured threshold
        thresholdExceeded: false, // client tries to bypass manual review
        lineItems: [{ title: "Model 1", price: "200.00", quantity: 1, properties: [] }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.mode, "quote");
  assertEquals(body.draftOrderId, "999");
  assertEquals(draftOrderCalled, true);
  assertEquals(variantCalled, false);
});

Deno.test("POST /checkout returns a generic 500 (no leaked details) when a downstream dependency throws", async () => {
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    createPricedVariant: () => Promise.reject(new Error("Shopify GraphQL error: secret internal detail")),
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 17.68,
        thresholdExceeded: false,
        lineItems: [{ title: "Model 1", price: "17.68", quantity: 1, properties: [] }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body, { error: "Internal error" });
});

Deno.test("POST /checkout with malformed JSON body returns 400, not 500", async () => {
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    }),
  );
  assertEquals(res.status, 400);
});

Deno.test("OPTIONS request returns CORS headers with no body", async () => {
  const res = await handleRequest(
    new Request("https://relay.test/checkout", { method: "OPTIONS" }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("unknown route returns 404", async () => {
  const res = await handleRequest(
    new Request("https://relay.test/nope", { method: "GET" }),
  );
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not found" });
});
