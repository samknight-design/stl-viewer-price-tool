import { assertEquals, assertRejects } from "std/testing/asserts.ts";
import { createPricedVariant } from "./variant.ts";

Deno.test("createPricedVariant returns the numeric variant id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({
        data: {
          productVariantsBulkCreate: {
            productVariants: [{ id: "gid://shopify/ProductVariant/44556677" }],
            userErrors: [],
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  try {
    const result = await createPricedVariant({ title: "Quote AF-20260802-ABCD", price: "17.68" });
    assertEquals(result.variantId, 44556677);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("createPricedVariant throws on empty variant response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({
        data: {
          productVariantsBulkCreate: {
            productVariants: [],
            userErrors: [],
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  try {
    await assertRejects(
      () => createPricedVariant({ title: "Quote AF-20260802-ABCD", price: "17.68" }),
      Error,
      "Shopify did not return a created variant",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
