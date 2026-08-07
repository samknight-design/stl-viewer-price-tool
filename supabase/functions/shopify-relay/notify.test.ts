// supabase/functions/shopify-relay/notify.test.ts
import { assertEquals } from "std/testing/asserts.ts";
import { sendQuoteNotification } from "./notify.ts";

Deno.test("sendQuoteNotification posts to Resend with the expected fields", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("RESEND_API_KEY");
  Deno.env.set("RESEND_API_KEY", "re_test_key");
  Deno.env.set("SHOPIFY_STORE_DOMAIN", "arcane-flame.myshopify.com");

  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = typeof input === "string" ? input : input.toString();
    capturedInit = init;
    return Promise.resolve(new Response(JSON.stringify({ id: "email_123" }), { status: 200 }));
  }) as typeof fetch;

  try {
    await sendQuoteNotification({
      quoteRef: "AF-20260807-ABCD",
      customerName: "Jane Smith",
      customerEmail: "jane@example.com",
      grandTotal: 180.5,
      draftOrderId: "999",
    });

    assertEquals(capturedUrl, "https://api.resend.com/emails");
    const headers = capturedInit?.headers as Record<string, string>;
    assertEquals(headers["Authorization"], "Bearer re_test_key");
    const body = JSON.parse(capturedInit?.body as string);
    assertEquals(body.to, ["orders@arcane-flame.com"]);
    assertEquals(body.subject.includes("AF-20260807-ABCD"), true);
    assertEquals(body.text.includes("Jane Smith"), true);
    assertEquals(body.text.includes("jane@example.com"), true);
    assertEquals(body.text.includes("180.50"), true);
    assertEquals(
      body.text.includes("https://admin.shopify.com/store/arcane-flame/draft_orders/999"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete("RESEND_API_KEY");
    else Deno.env.set("RESEND_API_KEY", originalKey);
  }
});

Deno.test("sendQuoteNotification does nothing (no throw) when RESEND_API_KEY is unset", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("RESEND_API_KEY");
  Deno.env.delete("RESEND_API_KEY");

  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    return Promise.resolve(new Response("", { status: 200 }));
  }) as typeof fetch;

  try {
    await sendQuoteNotification({
      quoteRef: "AF-1",
      customerName: "Jane",
      customerEmail: "jane@example.com",
      grandTotal: 10,
      draftOrderId: "1",
    });
    assertEquals(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey !== undefined) Deno.env.set("RESEND_API_KEY", originalKey);
  }
});

Deno.test("sendQuoteNotification does not throw when Resend returns an error status", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("RESEND_API_KEY");
  Deno.env.set("RESEND_API_KEY", "re_test_key");

  globalThis.fetch = (() =>
    Promise.resolve(new Response("bad request", { status: 400 }))) as typeof fetch;

  try {
    let threw = false;
    try {
      await sendQuoteNotification({
        quoteRef: "AF-1",
        customerName: "Jane",
        customerEmail: "jane@example.com",
        grandTotal: 10,
        draftOrderId: "1",
      });
    } catch {
      threw = true;
    }
    assertEquals(threw, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete("RESEND_API_KEY");
    else Deno.env.set("RESEND_API_KEY", originalKey);
  }
});

Deno.test("sendQuoteNotification does not throw when fetch itself rejects (network failure)", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get("RESEND_API_KEY");
  Deno.env.set("RESEND_API_KEY", "re_test_key");

  globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;

  try {
    let threw = false;
    try {
      await sendQuoteNotification({
        quoteRef: "AF-1",
        customerName: "Jane",
        customerEmail: "jane@example.com",
        grandTotal: 10,
        draftOrderId: "1",
      });
    } catch {
      threw = true;
    }
    assertEquals(threw, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete("RESEND_API_KEY");
    else Deno.env.set("RESEND_API_KEY", originalKey);
  }
});
