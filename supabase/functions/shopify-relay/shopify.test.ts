// supabase/functions/shopify-relay/shopify.test.ts
import { assertEquals, assertRejects } from "std/testing/asserts.ts";
import { __resetTokenCacheForTests, shopifyGraphQL } from "./shopify.ts";

function tokenResponse() {
  return Promise.resolve(
    new Response(
      JSON.stringify({ access_token: "shpat_fake", expires_in: 86400 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

Deno.test("shopifyGraphQL throws on GraphQL errors array", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = () => {
    call++;
    if (call === 1) return tokenResponse();
    return Promise.resolve(
      new Response(JSON.stringify({ errors: [{ message: "Field 'bogus' doesn't exist" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    await assertRejects(
      () => shopifyGraphQL("query { bogus }"),
      Error,
      "Field 'bogus' doesn't exist",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("shopifyGraphQL returns data on success", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = () => {
    call++;
    if (call === 1) return tokenResponse();
    return Promise.resolve(
      new Response(JSON.stringify({ data: { shop: { name: "Arcane Flame" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    const result = await shopifyGraphQL<{ shop: { name: string } }>("query { shop { name } }");
    assertEquals(result.shop.name, "Arcane Flame");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("shopifyGraphQL reuses a cached token across calls", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) {
      tokenCalls++;
      return tokenResponse();
    }
    return Promise.resolve(
      new Response(JSON.stringify({ data: { shop: { name: "Arcane Flame" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    await shopifyGraphQL("query { shop { name } }");
    await shopifyGraphQL("query { shop { name } }");
    assertEquals(tokenCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("shopifyGraphQL throws when token exchange fails", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response("unauthorized", { status: 401 }));
  try {
    await assertRejects(
      () => shopifyGraphQL("query { shop { name } }"),
      Error,
      "Shopify OAuth token exchange HTTP 401",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
