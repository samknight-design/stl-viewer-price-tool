// supabase/functions/shopify-relay/config.test.ts
import { assertEquals } from "std/testing/asserts.ts";
import { getShopConfig, saveShopConfig } from "./config.ts";
import { __resetTokenCacheForTests } from "./shopify.ts";

function tokenResponse() {
  return Promise.resolve(
    new Response(
      JSON.stringify({ access_token: "shpat_fake", expires_in: 86400 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

Deno.test("getShopConfig returns null when metafield unset", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = () => {
    call++;
    if (call === 1) return tokenResponse();
    return Promise.resolve(
      new Response(JSON.stringify({ data: { shop: { metafield: null } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    const config = await getShopConfig();
    assertEquals(config, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("getShopConfig parses stored JSON", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = () => {
    call++;
    if (call === 1) return tokenResponse();
    return Promise.resolve(
      new Response(JSON.stringify({
        data: {
          shop: { metafield: { value: JSON.stringify({ minimumOrderTotal: 5 }) } },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    const config = await getShopConfig();
    assertEquals(config, { minimumOrderTotal: 5 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("saveShopConfig calls metafieldsSet with serialized JSON", async () => {
  __resetTokenCacheForTests();
  let capturedBodies: string[] = [];
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (req: unknown, init?: RequestInit) => {
    callCount++;
    // Capture all request bodies
    if (init?.body && typeof init.body === "string") {
      capturedBodies.push(init.body);
    }
    // First call: token exchange
    // Second call: getShopGid queries for shop.id
    // Third call: saveShopConfig calls metafieldsSet
    if (callCount === 1) {
      return tokenResponse();
    } else if (callCount === 2) {
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
    // The third call should be the metafieldsSet mutation
    const body = JSON.parse(capturedBodies[2] || "{}");
    const variables = body.variables as Record<string, unknown>;
    const metafields = variables.metafields as Array<{ value: string }>;
    assertEquals(JSON.parse(metafields[0].value), { minimumOrderTotal: 5 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
