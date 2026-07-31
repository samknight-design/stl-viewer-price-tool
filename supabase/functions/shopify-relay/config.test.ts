// supabase/functions/shopify-relay/config.test.ts
import { assertEquals } from "std/testing/asserts.ts";
import { getShopConfig, saveShopConfig } from "./config.ts";

Deno.test("getShopConfig returns null when metafield unset", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ data: { shop: { metafield: null } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  try {
    const config = await getShopConfig();
    assertEquals(config, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("getShopConfig parses stored JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({
        data: {
          shop: { metafield: { value: JSON.stringify({ minimumOrderTotal: 5 }) } },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  try {
    const config = await getShopConfig();
    assertEquals(config, { minimumOrderTotal: 5 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("saveShopConfig calls metafieldsSet with serialized JSON", async () => {
  let capturedBodies: string[] = [];
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (req: unknown, init?: RequestInit) => {
    callCount++;
    // Capture all request bodies
    if (init?.body && typeof init.body === "string") {
      capturedBodies.push(init.body);
    }
    // First call: getShopGid queries for shop.id
    // Second call: saveShopConfig calls metafieldsSet
    if (callCount === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({
          data: { shop: { id: "gid://shopify/Shop/1" } },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } else {
      return Promise.resolve(
        new Response(JSON.stringify({
          data: { metafieldsSet: { userErrors: [] } },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
  };
  try {
    await saveShopConfig({ minimumOrderTotal: 5 });
    // The second call should be the metafieldsSet mutation
    const body = JSON.parse(capturedBodies[1] || "{}");
    const variables = body.variables as Record<string, unknown>;
    const metafields = variables.metafields as Array<{ value: string }>;
    assertEquals(JSON.parse(metafields[0].value), { minimumOrderTotal: 5 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
