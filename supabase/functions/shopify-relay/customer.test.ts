// supabase/functions/shopify-relay/customer.test.ts
import { assertEquals } from "std/testing/asserts.ts";
import { findOrCreateCustomer } from "./customer.ts";
import { __resetTokenCacheForTests } from "./shopify.ts";

function tokenResponse() {
  return Promise.resolve(
    new Response(
      JSON.stringify({ access_token: "shpat_fake", expires_in: 86400 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

function jsonResponse(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

Deno.test("findOrCreateCustomer creates a new customer when none exists, with consent when ticked", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ query: string; variables: unknown }> = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    calls.push({ query: body.query, variables: body.variables });

    if (body.query.includes("customers(")) {
      return jsonResponse({ data: { customers: { nodes: [] } } });
    }
    if (body.query.includes("customerCreate")) {
      return jsonResponse({
        data: {
          customerCreate: {
            customer: { id: "gid://shopify/Customer/555" },
            userErrors: [],
          },
        },
      });
    }
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    const result = await findOrCreateCustomer({
      email: "jane@example.com",
      name: "Jane Smith",
      marketingConsent: true,
    });
    assertEquals(result.id, "gid://shopify/Customer/555");

    const createCall = calls.find((c) => c.query.includes("customerCreate"));
    const input = (createCall?.variables as { input: Record<string, unknown> }).input;
    assertEquals(input.email, "jane@example.com");
    assertEquals(input.firstName, "Jane");
    assertEquals(input.lastName, "Smith");
    assertEquals(
      (input.emailMarketingConsent as { marketingState: string }).marketingState,
      "SUBSCRIBED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("findOrCreateCustomer creates a new customer with NOT_SUBSCRIBED when unticked", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("customers(")) {
      return jsonResponse({ data: { customers: { nodes: [] } } });
    }
    if (body.query.includes("customerCreate")) {
      const consent = body.variables.input.emailMarketingConsent;
      assertEquals(consent.marketingState, "NOT_SUBSCRIBED");
      assertEquals(consent.marketingOptInLevel, null);
      return jsonResponse({
        data: {
          customerCreate: {
            customer: { id: "gid://shopify/Customer/556" },
            userErrors: [],
          },
        },
      });
    }
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    const result = await findOrCreateCustomer({
      email: "no-thanks@example.com",
      name: "No Thanks",
      marketingConsent: false,
    });
    assertEquals(result.id, "gid://shopify/Customer/556");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("findOrCreateCustomer reuses an existing customer found by email and does not create a duplicate", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let createCalled = false;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("customers(")) {
      return jsonResponse({
        data: {
          customers: {
            nodes: [{
              id: "gid://shopify/Customer/100",
              emailMarketingConsent: { marketingState: "SUBSCRIBED" },
            }],
          },
        },
      });
    }
    if (body.query.includes("customerCreate")) {
      createCalled = true;
      throw new Error("should not create when customer already exists");
    }
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    const result = await findOrCreateCustomer({
      email: "returning@example.com",
      name: "Returning Customer",
      marketingConsent: false,
    });
    assertEquals(result.id, "gid://shopify/Customer/100");
    assertEquals(createCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("findOrCreateCustomer upgrades an existing not-subscribed customer to subscribed when consent is newly ticked, but never downgrades", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let updateCalled = false;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("customers(")) {
      return jsonResponse({
        data: {
          customers: {
            nodes: [{
              id: "gid://shopify/Customer/200",
              emailMarketingConsent: { marketingState: "NOT_SUBSCRIBED" },
            }],
          },
        },
      });
    }
    if (body.query.includes("customerUpdate")) {
      updateCalled = true;
      assertEquals(body.variables.input.id, "gid://shopify/Customer/200");
      assertEquals(
        body.variables.input.emailMarketingConsent.marketingState,
        "SUBSCRIBED",
      );
      return jsonResponse({
        data: { customerUpdate: { customer: { id: "gid://shopify/Customer/200" }, userErrors: [] } },
      });
    }
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    const result = await findOrCreateCustomer({
      email: "upgrading@example.com",
      name: "Upgrading Customer",
      marketingConsent: true,
    });
    assertEquals(result.id, "gid://shopify/Customer/200");
    assertEquals(updateCalled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("findOrCreateCustomer does not call customerUpdate when marketingConsent is false, even for an existing unsubscribed customer", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let updateCalled = false;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("customers(")) {
      return jsonResponse({
        data: {
          customers: {
            nodes: [{
              id: "gid://shopify/Customer/300",
              emailMarketingConsent: { marketingState: "NOT_SUBSCRIBED" },
            }],
          },
        },
      });
    }
    if (body.query.includes("customerUpdate")) {
      updateCalled = true;
    }
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    const result = await findOrCreateCustomer({
      email: "no-op@example.com",
      name: "No Op",
      marketingConsent: false,
    });
    assertEquals(result.id, "gid://shopify/Customer/300");
    assertEquals(updateCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("findOrCreateCustomer splits a single-word name into firstName only", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("customers(")) {
      return jsonResponse({ data: { customers: { nodes: [] } } });
    }
    if (body.query.includes("customerCreate")) {
      assertEquals(body.variables.input.firstName, "Madonna");
      assertEquals(body.variables.input.lastName, "");
      return jsonResponse({
        data: {
          customerCreate: {
            customer: { id: "gid://shopify/Customer/400" },
            userErrors: [],
          },
        },
      });
    }
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    await findOrCreateCustomer({
      email: "madonna@example.com",
      name: "Madonna",
      marketingConsent: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
