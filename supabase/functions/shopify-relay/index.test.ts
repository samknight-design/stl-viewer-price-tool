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

Deno.test("POST /files/stage returns the staged upload target", async () => {
  const deps = fakeDeps({
    stageUpload: (input) =>
      Promise.resolve({
        uploadUrl: `https://project-ref.supabase.co/storage/v1/object/upload/sign/quote-uploads/abc123/${input.filename}?token=fake-token`,
        publicUrl: `https://project-ref.supabase.co/storage/v1/object/public/quote-uploads/abc123/${input.filename}`,
      }),
  });
  const res = await handleRequest(
    new Request("https://relay.test/files/stage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "model.stl", mimeType: "model/stl", fileSize: 1024 }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    uploadUrl: "https://project-ref.supabase.co/storage/v1/object/upload/sign/quote-uploads/abc123/model.stl?token=fake-token",
    publicUrl: "https://project-ref.supabase.co/storage/v1/object/public/quote-uploads/abc123/model.stl",
  });
});

Deno.test("POST /checkout below threshold creates a priced variant and returns first line item's properties", async () => {
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
  assertEquals(await res.json(), {
    mode: "cart",
    variantId: 999,
    properties: { _quote_ref: "AF-1", _model_name: "Model 1" },
  });
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
  assertEquals(await res.json(), { mode: "cart", variantId: 999, properties: {} });
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
