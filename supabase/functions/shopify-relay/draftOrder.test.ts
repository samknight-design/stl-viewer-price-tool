import { assertEquals } from "std/testing/asserts.ts";
import { createDraftOrder } from "./draftOrder.ts";

Deno.test("createDraftOrder returns the invoice URL", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({
        data: {
          draftOrderCreate: {
            draftOrder: { invoiceUrl: "https://arcane-flame.myshopify.com/123/invoices/abc" },
            userErrors: [],
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  try {
    const result = await createDraftOrder({
      customerEmail: "jane@example.com",
      customerName: "Jane Smith",
      lineItems: [{
        title: "Model 1",
        price: "180.00",
        quantity: 1,
        properties: [{ name: "_quote_ref", value: "AF-20260802-ABCD" }],
      }],
    });
    assertEquals(result.invoiceUrl, "https://arcane-flame.myshopify.com/123/invoices/abc");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("createDraftOrder throws clear error when draftOrder is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({
        data: {
          draftOrderCreate: {
            draftOrder: null,
            userErrors: [],
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  try {
    await createDraftOrder({
      customerEmail: "jane@example.com",
      customerName: "Jane Smith",
      lineItems: [{
        title: "Model 1",
        price: "180.00",
        quantity: 1,
        properties: [{ name: "_quote_ref", value: "AF-20260802-ABCD" }],
      }],
    });
    throw new Error("Expected an error to be thrown");
  } catch (err) {
    if (err instanceof Error && err.message === "Expected an error to be thrown") {
      throw err;
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (!errorMessage.includes("did not return a created draft order")) {
      throw new Error(`Expected error about missing draftOrder, got: ${errorMessage}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
