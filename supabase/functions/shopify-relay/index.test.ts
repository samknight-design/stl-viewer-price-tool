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
    uploadFile: () => {
      throw new Error("uploadFile not stubbed");
    },
    createPricedVariant: () => {
      throw new Error("createPricedVariant not stubbed");
    },
    createDraftOrder: () => {
      throw new Error("createDraftOrder not stubbed");
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

Deno.test("POST /files uploads and returns file id/url", async () => {
  const deps = fakeDeps({
    uploadFile: (input) =>
      Promise.resolve({ id: `gid://shopify/File/1-${input.filename}`, url: "https://cdn.example.com/f.png" }),
  });
  const res = await handleRequest(
    new Request("https://relay.test/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "model.png", mimeType: "image/png", base64Data: "AAAA" }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    id: "gid://shopify/File/1-model.png",
    url: "https://cdn.example.com/f.png",
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

Deno.test("POST /checkout above threshold creates a draft order", async () => {
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    createDraftOrder: () => Promise.resolve({ invoiceUrl: "https://example.com/invoice" }),
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
        lineItems: [{ title: "Model 1", price: "180.00", quantity: 1, properties: [] }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { mode: "draft-order", invoiceUrl: "https://example.com/invoice" });
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

Deno.test("POST /checkout forces a draft order server-side when grandTotal exceeds the configured threshold, even if thresholdExceeded is false", async () => {
  let draftOrderCalled = false;
  let variantCalled = false;
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve({ customQuoteOrderThreshold: 150 }),
    createDraftOrder: () => {
      draftOrderCalled = true;
      return Promise.resolve({ invoiceUrl: "https://example.com/invoice" });
    },
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
  assertEquals(await res.json(), { mode: "draft-order", invoiceUrl: "https://example.com/invoice" });
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
