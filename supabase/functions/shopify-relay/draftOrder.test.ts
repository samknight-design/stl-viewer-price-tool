import { assertEquals } from "std/testing/asserts.ts";
import { createDraftOrder } from "./draftOrder.ts";
import { __resetTokenCacheForTests } from "./shopify.ts";

function tokenResponse() {
  return Promise.resolve(
    new Response(
      JSON.stringify({ access_token: "shpat_fake", expires_in: 86400 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

Deno.test("createDraftOrder returns the numeric draft order id and sends customerId/tags/note", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let capturedInput: Record<string, unknown> | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    capturedInput = body.variables.input;
    return Promise.resolve(
      new Response(JSON.stringify({
        data: {
          draftOrderCreate: {
            draftOrder: { id: "gid://shopify/DraftOrder/778899", name: "#D5" },
            userErrors: [],
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    const result = await createDraftOrder({
      customerId: "gid://shopify/Customer/555",
      note: "Quote AF-20260802-ABCD for Jane Smith (jane@example.com) — review before sending invoice.",
      tags: ["quote", "quote-ref:AF-20260802-ABCD"],
      lineItems: [{
        title: "Model 1",
        price: "180.00",
        quantity: 1,
        properties: [{ name: "_quote_ref", value: "AF-20260802-ABCD" }],
      }],
    });
    assertEquals(result.draftOrderId, "778899");
    assertEquals(capturedInput?.customerId, "gid://shopify/Customer/555");
    assertEquals(capturedInput?.tags, ["quote", "quote-ref:AF-20260802-ABCD"]);
    assertEquals(
      capturedInput?.note2,
      "Quote AF-20260802-ABCD for Jane Smith (jane@example.com) — review before sending invoice.",
    );
    const lineItems = capturedInput?.lineItems as Array<Record<string, unknown>>;
    assertEquals(lineItems[0].title, "Model 1");
    assertEquals(lineItems[0].originalUnitPrice, "180.00");
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
      customerId: "gid://shopify/Customer/555",
      note: "note",
      tags: ["quote"],
      lineItems: [{
        title: "Model 1",
        price: "180.00",
        quantity: 1,
        properties: [],
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
