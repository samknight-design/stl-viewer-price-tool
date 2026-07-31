// supabase/functions/shopify-relay/shopify.test.ts
import { assertEquals, assertRejects } from "std/testing/asserts.ts";
import { shopifyGraphQL } from "./shopify.ts";

Deno.test("shopifyGraphQL throws on GraphQL errors array", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ errors: [{ message: "Field 'bogus' doesn't exist" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ data: { shop: { name: "Arcane Flame" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  try {
    const result = await shopifyGraphQL<{ shop: { name: string } }>("query { shop { name } }");
    assertEquals(result.shop.name, "Arcane Flame");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
