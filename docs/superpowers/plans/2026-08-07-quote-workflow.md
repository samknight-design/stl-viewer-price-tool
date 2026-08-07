# Quote Request Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the over-threshold "quote" checkout path (which today silently redirects the customer to a real Shopify payment page) with a genuine review workflow: create a Shopify customer with GDPR-compliant marketing consent, create an unsent draft order carrying the full breakdown and clickable uploaded-file links, notify the shop owner by email, and show the customer an in-page confirmation — never a payment screen.

**Architecture:** Three new/changed relay modules (`customer.ts` for find-or-create-customer with consent, `notify.ts` for the Resend notification email, `files.ts` gains a `resolveFileUrl` helper) plus a rewritten `draftOrder.ts` (customer-linked, tagged, unsent) orchestrated from `index.ts`'s `/checkout` over-threshold branch. Frontend changes (Shopify theme `print-calc-*` files, mirrored into the standalone `js/`+`index.html` tool) add a conditional GDPR marketing-consent checkbox to the contact-form step and change the post-submit response handling to show the existing (currently-dead) success screen instead of redirecting.

**Tech Stack:** Deno (Supabase Edge Function), TypeScript, Shopify Admin GraphQL API, Resend (transactional email), vanilla JS frontend.

## Global Constraints

- Under-threshold auto-checkout path is **out of scope** — do not touch `createPricedVariant`, the "cart" mode branch, or its tests.
- Every relay change follows the existing dependency-injection test pattern (`RelayDeps` in `index.ts`; fetch-mocked module tests with `__resetTokenCacheForTests()` + `/admin/oauth/access_token` mock response, per `files.test.ts`/`draftOrder.test.ts`).
- The draft order created by this flow must never be sent to the customer (no `draftOrderInvoiceSend` call anywhere in this codebase) and the frontend must never navigate/redirect on the quote path.
- Marketing consent checkbox must be **unticked by default** (UK GDPR/PECR: consent must be freely given, not pre-checked).
- Both the Shopify theme copy (`shopify-theme/assets/print-calc-*`) and the standalone copy (`js/*`, `index.html`) must be updated in parallel — they are parallel mirrors, not a single source of truth.

---

### Task 1: Add new environment variables

**Files:**
- Modify: `supabase/functions/shopify-relay/.env.example`

**Interfaces:**
- Produces: three new env var names (`RESEND_API_KEY`, `NOTIFY_TO_EMAIL`, `RESEND_FROM_EMAIL`) that Tasks 2–6 read via `Deno.env.get(...)`.

- [ ] **Step 1: Add the new variables to `.env.example`**

Current content:
```
SHOPIFY_STORE_DOMAIN=arcane-flame.myshopify.com
SHOPIFY_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_CLIENT_SECRET=shpss_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_VERSION=2025-01
ADMIN_PASSWORD=change-me
PRINT_PRODUCT_ID=1234567890
```

New content:
```
SHOPIFY_STORE_DOMAIN=arcane-flame.myshopify.com
SHOPIFY_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_CLIENT_SECRET=shpss_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_VERSION=2025-01
ADMIN_PASSWORD=change-me
PRINT_PRODUCT_ID=1234567890
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTIFY_TO_EMAIL=orders@arcane-flame.com
RESEND_FROM_EMAIL=quotes@arcane-flame.com
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/shopify-relay/.env.example
git commit -m "Add Resend notification env vars to relay .env.example"
```

---

### Task 2: `customer.ts` — find-or-create customer with GDPR consent

**Files:**
- Create: `supabase/functions/shopify-relay/customer.ts`
- Test: `supabase/functions/shopify-relay/customer.test.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL<T>(query, variables?)` from `./shopify.ts` (existing — throws on HTTP error, GraphQL `errors[]`, or any top-level `userErrors[]`).
- Produces: `findOrCreateCustomer(input: FindOrCreateCustomerInput): Promise<CustomerResult>` where
  ```ts
  interface FindOrCreateCustomerInput {
    email: string;
    name: string;
    marketingConsent: boolean;
  }
  interface CustomerResult {
    id: string; // gid://shopify/Customer/...
  }
  ```
  Consumed by Task 6 (`index.ts`).

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/shopify-relay/customer.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd supabase/functions/shopify-relay && deno test customer.test.ts`
Expected: FAIL — `customer.ts` does not exist yet (module not found).

- [ ] **Step 3: Write `customer.ts`**

Create `supabase/functions/shopify-relay/customer.ts`:
```ts
// supabase/functions/shopify-relay/customer.ts
import { shopifyGraphQL } from "./shopify.ts";

export interface FindOrCreateCustomerInput {
  email: string;
  /** Full display name, split best-effort into first/last for Shopify. */
  name: string;
  marketingConsent: boolean;
}

export interface CustomerResult {
  id: string;
}

const FIND_CUSTOMER_QUERY = `
  query FindCustomerByEmail($query: String!) {
    customers(first: 1, query: $query) {
      nodes {
        id
        emailMarketingConsent { marketingState }
      }
    }
  }
`;

const CREATE_CUSTOMER_MUTATION = `
  mutation CreateCustomer($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

const UPDATE_CUSTOMER_CONSENT_MUTATION = `
  mutation UpdateCustomerConsent($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

/** Best-effort split — Shopify wants firstName/lastName, our form only collects one field. */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

function consentInput(marketingConsent: boolean) {
  return {
    marketingState: marketingConsent ? "SUBSCRIBED" : "NOT_SUBSCRIBED",
    marketingOptInLevel: marketingConsent ? "SINGLE_OPT_IN" : null,
    consentUpdatedAt: new Date().toISOString(),
  };
}

/**
 * Finds an existing Shopify customer by email, or creates one. Existing
 * customers are never duplicated (avoids Shopify's "email taken" error on
 * repeat quotes from the same person) and their marketing consent is only
 * ever upgraded (unticked-by-default never downgrades an existing
 * subscription — a customer who already opted in stays opted in even if a
 * later quote form submission doesn't re-tick the box).
 */
export async function findOrCreateCustomer(
  input: FindOrCreateCustomerInput,
): Promise<CustomerResult> {
  const escapedEmail = input.email.replace(/"/g, '\\"');
  const found = await shopifyGraphQL<{
    customers: {
      nodes: Array<{ id: string; emailMarketingConsent: { marketingState: string } | null }>;
    };
  }>(FIND_CUSTOMER_QUERY, { query: `email:"${escapedEmail}"` });

  const existing = found.customers.nodes[0];
  if (existing) {
    const alreadySubscribed = existing.emailMarketingConsent?.marketingState === "SUBSCRIBED";
    if (input.marketingConsent && !alreadySubscribed) {
      await shopifyGraphQL(UPDATE_CUSTOMER_CONSENT_MUTATION, {
        input: { id: existing.id, emailMarketingConsent: consentInput(true) },
      });
    }
    return { id: existing.id };
  }

  const { firstName, lastName } = splitName(input.name);
  const created = await shopifyGraphQL<{
    customerCreate: { customer: { id: string } | null };
  }>(CREATE_CUSTOMER_MUTATION, {
    input: {
      email: input.email,
      firstName,
      lastName,
      emailMarketingConsent: consentInput(input.marketingConsent),
    },
  });

  if (!created.customerCreate.customer) {
    throw new Error("Shopify did not return a created customer");
  }
  return { id: created.customerCreate.customer.id };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd supabase/functions/shopify-relay && deno test customer.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shopify-relay/customer.ts supabase/functions/shopify-relay/customer.test.ts
git commit -m "Add findOrCreateCustomer: GDPR-consent-aware Shopify customer upsert"
```

---

### Task 3: `files.ts` — resolve a Shopify file's public URL

**Files:**
- Modify: `supabase/functions/shopify-relay/files.ts`
- Modify: `supabase/functions/shopify-relay/files.test.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL<T>` (existing).
- Produces: `resolveFileUrl(fileId: string): Promise<string | null>`, added as a new named export alongside the existing `uploadFile`. Consumed by Task 6 (`index.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `supabase/functions/shopify-relay/files.test.ts` (add these `Deno.test` blocks after the existing ones, keep existing imports — add `resolveFileUrl` to the existing `import { uploadFile } from "./files.ts";` line so it reads `import { uploadFile, resolveFileUrl } from "./files.ts";`):
```ts
Deno.test("resolveFileUrl returns the url immediately for a GenericFile that's already processed", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("node(id:")) {
      callCount++;
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: { node: { url: "https://cdn.example/part.stl" } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    const result = await resolveFileUrl("gid://shopify/GenericFile/1");
    assertEquals(result, "https://cdn.example/part.stl");
    assertEquals(callCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("resolveFileUrl reads image.url for a MediaImage node", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("node(id:")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: { node: { image: { url: "https://cdn.example/thumb.png" } } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    const result = await resolveFileUrl("gid://shopify/MediaImage/2");
    assertEquals(result, "https://cdn.example/thumb.png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("resolveFileUrl retries when the file is still processing, then returns the url once ready", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("node(id:")) {
      callCount++;
      const nodeResult = callCount < 2 ? { url: null } : { url: "https://cdn.example/ready.stl" };
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: { node: nodeResult } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    const result = await resolveFileUrl("gid://shopify/GenericFile/3");
    assertEquals(result, "https://cdn.example/ready.stl");
    assertEquals(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("resolveFileUrl gives up and returns null after exhausting retries", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("node(id:")) {
      callCount++;
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: { node: { url: null } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    const result = await resolveFileUrl("gid://shopify/GenericFile/4");
    assertEquals(result, null);
    assertEquals(callCount, 3); // initial attempt + 2 retries
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd supabase/functions/shopify-relay && deno test files.test.ts`
Expected: FAIL — `resolveFileUrl` is not exported from `./files.ts`.

- [ ] **Step 3: Add `resolveFileUrl` to `files.ts`**

Modify `supabase/functions/shopify-relay/files.ts` — add this after the existing `uploadFile` function (at the end of the file), no changes to existing code:
```ts

const RESOLVE_FILE_QUERY = `
  query ResolveFileUrl($id: ID!) {
    node(id: $id) {
      ... on GenericFile { url }
      ... on MediaImage { image { url } }
    }
  }
`;

// Shopify processes uploaded files asynchronously — a file created moments
// ago may not have a resolved download URL yet. Two short retries (not a
// long poll) cover the common case without meaningfully delaying quote
// creation; if still unresolved, the caller falls back to referencing the
// file by its Shopify GID instead of a clickable link (see index.ts).
const FILE_URL_RETRY_DELAYS_MS = [500, 500];

export async function resolveFileUrl(fileId: string): Promise<string | null> {
  for (let attempt = 0; attempt <= FILE_URL_RETRY_DELAYS_MS.length; attempt++) {
    const data = await shopifyGraphQL<{
      node: { url?: string | null; image?: { url: string } | null } | null;
    }>(RESOLVE_FILE_QUERY, { id: fileId });
    const url = data.node?.url ?? data.node?.image?.url ?? null;
    if (url) return url;
    if (attempt < FILE_URL_RETRY_DELAYS_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, FILE_URL_RETRY_DELAYS_MS[attempt]));
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd supabase/functions/shopify-relay && deno test files.test.ts`
Expected: PASS (all tests, including the 4 new ones — note the retry test takes ~500ms and the exhausted-retries test takes ~1000ms of real wall-clock time, that's expected)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shopify-relay/files.ts supabase/functions/shopify-relay/files.test.ts
git commit -m "Add resolveFileUrl: resolve a Shopify file's download URL with short retry"
```

---

### Task 4: `notify.ts` — quote notification email via Resend

**Files:**
- Create: `supabase/functions/shopify-relay/notify.ts`
- Test: `supabase/functions/shopify-relay/notify.test.ts`

**Interfaces:**
- Consumes: nothing from other relay modules (talks to Resend's HTTP API directly, not Shopify).
- Produces: `sendQuoteNotification(input: QuoteNotificationInput): Promise<void>` where
  ```ts
  interface QuoteNotificationInput {
    quoteRef: string;
    customerName: string;
    customerEmail: string;
    grandTotal: number;
    draftOrderId: string; // numeric Shopify draft order id
  }
  ```
  Never throws — logs and swallows all failures. Consumed by Task 6 (`index.ts`).

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/shopify-relay/notify.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd supabase/functions/shopify-relay && deno test notify.test.ts`
Expected: FAIL — `notify.ts` does not exist yet.

- [ ] **Step 3: Write `notify.ts`**

Create `supabase/functions/shopify-relay/notify.ts`:
```ts
// supabase/functions/shopify-relay/notify.ts

export interface QuoteNotificationInput {
  quoteRef: string;
  customerName: string;
  customerEmail: string;
  grandTotal: number;
  /** Numeric Shopify draft order id (not the full GID). */
  draftOrderId: string;
}

function adminDraftOrderUrl(draftOrderId: string): string {
  const storeDomain = Deno.env.get("SHOPIFY_STORE_DOMAIN") ?? "";
  const storeHandle = storeDomain.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${storeHandle}/draft_orders/${draftOrderId}`;
}

/**
 * Emails the shop owner that a new quote draft order was created. Shopify
 * does not do this automatically for API-created draft orders (only for
 * merchant-sent invoices), so without this the shop owner has no signal
 * that a quote is waiting for review. Best-effort: never throws — a failed
 * notification must not fail the quote request itself, since the draft
 * order (the actual source of truth) already exists by the time this runs.
 */
export async function sendQuoteNotification(input: QuoteNotificationInput): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set — skipping quote notification email");
    return;
  }

  const toEmail = Deno.env.get("NOTIFY_TO_EMAIL") ?? "orders@arcane-flame.com";
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") ?? "quotes@arcane-flame.com";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: `New quote request ${input.quoteRef} — £${input.grandTotal.toFixed(2)}`,
        text: [
          `New quote from ${input.customerName} (${input.customerEmail})`,
          "",
          `Reference: ${input.quoteRef}`,
          `Total: £${input.grandTotal.toFixed(2)}`,
          "",
          "Review and send the invoice here:",
          adminDraftOrderUrl(input.draftOrderId),
        ].join("\n"),
      }),
    });
    if (!res.ok) {
      console.error(`Resend notification failed: HTTP ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error("Resend notification failed:", err);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd supabase/functions/shopify-relay && deno test notify.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shopify-relay/notify.ts supabase/functions/shopify-relay/notify.test.ts
git commit -m "Add sendQuoteNotification: best-effort Resend email when a quote draft order is created"
```

---

### Task 5: Rewrite `draftOrder.ts` — customer-linked, tagged, unsent

**Files:**
- Modify: `supabase/functions/shopify-relay/draftOrder.ts`
- Modify: `supabase/functions/shopify-relay/draftOrder.test.ts` (full rewrite — the input/output shape changes)

**Interfaces:**
- Consumes: `shopifyGraphQL<T>` (existing).
- Produces (**breaking change** from today):
  ```ts
  interface QuoteLineItem {
    title: string;
    price: string;
    quantity: number;
    properties: Array<{ name: string; value: string }>;
  }
  interface CreateDraftOrderInput {
    customerId: string;
    note: string;
    tags: string[];
    lineItems: QuoteLineItem[];
  }
  createDraftOrder(input: CreateDraftOrderInput): Promise<{ draftOrderId: string }>
  ```
  `QuoteLineItem` is unchanged in shape (still exported). `createDraftOrder`'s input no longer takes `customerEmail`/`customerName` (replaced by `customerId` + `note`, both prepared by the caller in Task 6) and its return no longer includes `invoiceUrl` (replaced by `draftOrderId`, the numeric id needed by `notify.ts`). Consumed by Task 6 (`index.ts`).

- [ ] **Step 1: Replace `draftOrder.test.ts` entirely**

Replace the full contents of `supabase/functions/shopify-relay/draftOrder.test.ts`:
```ts
import { assertEquals } from "std/testing/asserts.ts";
import { createDraftOrder } from "./draftOrder.ts";

Deno.test("createDraftOrder returns the numeric draft order id and sends customerId/tags/note", async () => {
  const originalFetch = globalThis.fetch;
  let capturedInput: Record<string, unknown> | undefined;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd supabase/functions/shopify-relay && deno test draftOrder.test.ts`
Expected: FAIL — current `createDraftOrder` doesn't accept `customerId`/`note`/`tags` and returns `invoiceUrl` not `draftOrderId`.

- [ ] **Step 3: Rewrite `draftOrder.ts`**

Replace the full contents of `supabase/functions/shopify-relay/draftOrder.ts`:
```ts
import { shopifyGraphQL } from "./shopify.ts";

export interface QuoteLineItem {
  title: string;
  /** Decimal string, e.g. "180.00" */
  price: string;
  quantity: number;
  properties: Array<{ name: string; value: string }>;
}

export interface CreateDraftOrderInput {
  customerId: string;
  note: string;
  tags: string[];
  lineItems: QuoteLineItem[];
}

const CREATE_DRAFT_ORDER_MUTATION = `
  mutation CreateDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }
`;

/**
 * Creates an unsent draft order linked to a real Shopify customer. This
 * never sends an invoice to the customer (no draftOrderInvoiceSend call
 * anywhere in this codebase) — it's meant to sit in Shopify Admin for
 * manual review/editing before the shop owner sends it themselves.
 */
export async function createDraftOrder(
  input: CreateDraftOrderInput,
): Promise<{ draftOrderId: string }> {
  const data = await shopifyGraphQL<{
    draftOrderCreate: { draftOrder: { id: string; name: string } | null };
  }>(CREATE_DRAFT_ORDER_MUTATION, {
    input: {
      customerId: input.customerId,
      note2: input.note,
      tags: input.tags,
      lineItems: input.lineItems.map((li) => ({
        title: li.title,
        originalUnitPrice: li.price,
        quantity: li.quantity,
        requiresShipping: true,
        taxable: true,
        customAttributes: li.properties,
      })),
    },
  });

  const draftOrder = data.draftOrderCreate.draftOrder;
  if (!draftOrder) {
    throw new Error("Shopify did not return a created draft order");
  }

  const draftOrderId = draftOrder.id.split("/").pop()!;
  return { draftOrderId };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd supabase/functions/shopify-relay && deno test draftOrder.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shopify-relay/draftOrder.ts supabase/functions/shopify-relay/draftOrder.test.ts
git commit -m "Rewrite createDraftOrder: link to customer, tag with quote ref, never invoice-send"
```

---

### Task 6: `index.ts` — orchestrate the new quote flow

**Files:**
- Modify: `supabase/functions/shopify-relay/index.ts`
- Modify: `supabase/functions/shopify-relay/index.test.ts`

**Interfaces:**
- Consumes: `findOrCreateCustomer` (Task 2), `resolveFileUrl` (Task 3), `sendQuoteNotification` (Task 4), the new `createDraftOrder` shape (Task 5).
- Produces: `/checkout` response for the over-threshold branch changes from `{ mode: "draft-order", invoiceUrl }` to `{ mode: "quote", quoteRef, draftOrderId }`. Request body gains an optional `marketingConsent: boolean` field. Consumed by Task 9 (frontend).

- [ ] **Step 1: Update `fakeDeps()` and the two affected tests in `index.test.ts`**

In `supabase/functions/shopify-relay/index.test.ts`, replace the `fakeDeps` function (near the top) with:
```ts
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
    findOrCreateCustomer: () => {
      throw new Error("findOrCreateCustomer not stubbed");
    },
    resolveFileUrl: () => {
      throw new Error("resolveFileUrl not stubbed");
    },
    sendQuoteNotification: () => {
      throw new Error("sendQuoteNotification not stubbed");
    },
    ...overrides,
  };
}
```

Replace the `"POST /checkout above threshold creates a draft order"` test with:
```ts
Deno.test("POST /checkout above threshold creates a customer, a linked draft order, sends a notification, and returns quote mode", async () => {
  let customerCalled = false;
  let draftOrderCalled = false;
  let notificationCalled = false;
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    findOrCreateCustomer: (input) => {
      customerCalled = true;
      assertEquals(input.email, "jane@example.com");
      assertEquals(input.name, "Jane Smith");
      assertEquals(input.marketingConsent, true);
      return Promise.resolve({ id: "gid://shopify/Customer/1" });
    },
    resolveFileUrl: () => Promise.resolve("https://cdn.example/part.stl"),
    createDraftOrder: (input) => {
      draftOrderCalled = true;
      assertEquals(input.customerId, "gid://shopify/Customer/1");
      assertEquals(input.tags.includes("quote"), true);
      return Promise.resolve({ draftOrderId: "999" });
    },
    sendQuoteNotification: (input) => {
      notificationCalled = true;
      assertEquals(input.draftOrderId, "999");
      return Promise.resolve();
    },
  });
  const res = await handleRequest(
    new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        marketingConsent: true,
        grandTotal: 180,
        thresholdExceeded: true,
        lineItems: [{
          title: "Model 1",
          price: "180.00",
          quantity: 1,
          properties: [
            { name: "_quote_ref", value: "AF-20260807-XYZ" },
            {
              name: "_files_json",
              value: JSON.stringify([{
                filename: "part.stl",
                fileId: "gid://shopify/GenericFile/1",
                thumbnailId: null,
                quantity: 1,
              }]),
            },
          ],
        }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    mode: "quote",
    quoteRef: "AF-20260807-XYZ",
    draftOrderId: "999",
  });
  assertEquals(customerCalled, true);
  assertEquals(draftOrderCalled, true);
  assertEquals(notificationCalled, true);
});
```

Replace the `"POST /checkout forces a draft order server-side..."` test's dependency setup and assertions (keep the test name and request body the same, only the `deps` and final assertions change):
```ts
Deno.test("POST /checkout forces a draft order server-side when grandTotal exceeds the configured threshold, even if thresholdExceeded is false", async () => {
  let draftOrderCalled = false;
  let variantCalled = false;
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve({ customQuoteOrderThreshold: 150 }),
    findOrCreateCustomer: () => Promise.resolve({ id: "gid://shopify/Customer/1" }),
    resolveFileUrl: () => Promise.resolve(null),
    createDraftOrder: () => {
      draftOrderCalled = true;
      return Promise.resolve({ draftOrderId: "999" });
    },
    sendQuoteNotification: () => Promise.resolve(),
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
  const body = await res.json();
  assertEquals(body.mode, "quote");
  assertEquals(body.draftOrderId, "999");
  assertEquals(draftOrderCalled, true);
  assertEquals(variantCalled, false);
});
```

Add one new test after those (covers the file-URL-resolution-failure-doesn't-block-the-quote requirement from the spec):
```ts
Deno.test("POST /checkout still creates the quote when a file URL fails to resolve", async () => {
  const deps = fakeDeps({
    getShopConfig: () => Promise.resolve(null),
    findOrCreateCustomer: () => Promise.resolve({ id: "gid://shopify/Customer/1" }),
    resolveFileUrl: () => Promise.resolve(null), // simulates a still-processing file
    createDraftOrder: () => Promise.resolve({ draftOrderId: "999" }),
    sendQuoteNotification: () => Promise.resolve(),
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
        lineItems: [{
          title: "Model 1",
          price: "180.00",
          quantity: 1,
          properties: [
            { name: "_quote_ref", value: "AF-1" },
            {
              name: "_files_json",
              value: JSON.stringify([{
                filename: "part.stl",
                fileId: "gid://shopify/GenericFile/1",
                thumbnailId: null,
                quantity: 1,
              }]),
            },
          ],
        }],
      }),
    }),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.mode, "quote");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd supabase/functions/shopify-relay && deno test index.test.ts`
Expected: FAIL — `RelayDeps` doesn't have `findOrCreateCustomer`/`resolveFileUrl`/`sendQuoteNotification` yet, `createDraftOrder` return shape mismatch, `/checkout` still returns the old `{ mode: "draft-order", invoiceUrl }` shape.

- [ ] **Step 3: Rewrite `index.ts`**

Replace the full contents of `supabase/functions/shopify-relay/index.ts`:
```ts
// supabase/functions/shopify-relay/index.ts
import { getShopConfig, saveShopConfig } from "./config.ts";
import { uploadFile, resolveFileUrl } from "./files.ts";
import { createPricedVariant } from "./variant.ts";
import { createDraftOrder, type QuoteLineItem } from "./draftOrder.ts";
import { findOrCreateCustomer } from "./customer.ts";
import { sendQuoteNotification } from "./notify.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-admin-password",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

// Sentinel thrown by readJsonBody() and caught right at the call site (not
// the outer generic-500 handler) so a malformed/non-JSON request body is a
// 400 client error, not a 500 — the outer catch is for genuine server-side
// failures further down (Shopify API errors, etc.).
class BadJsonError extends Error {}

async function readJsonBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new BadJsonError("Malformed JSON request body");
  }
}

/** One uploaded file's record as sent by the frontend in a line item's `_files_json` property. */
interface QuoteFileRecord {
  filename: string;
  fileId: string | null;
  thumbnailId: string | null;
  quantity: number;
}

/**
 * Resolves clickable download URLs for every file referenced in a line
 * item's `_files_json` property, returning a new line item with that
 * property's value replaced by the enriched (fileUrl/thumbnailUrl added)
 * JSON. Non-`_files_json` properties, and line items with no `_files_json`
 * property, pass through unchanged. A file whose URL can't be resolved
 * (still processing) gets `fileUrl: null` rather than blocking the quote.
 */
async function enrichLineItemWithFileUrls(
  lineItem: QuoteLineItem,
  resolveFileUrlFn: typeof resolveFileUrl,
): Promise<QuoteLineItem> {
  const properties = await Promise.all(lineItem.properties.map(async (p) => {
    if (p.name !== "_files_json") return p;
    let files: QuoteFileRecord[];
    try {
      files = JSON.parse(p.value);
    } catch {
      return p;
    }
    const enriched = await Promise.all(files.map(async (f) => ({
      ...f,
      fileUrl: f.fileId ? await resolveFileUrlFn(f.fileId) : null,
      thumbnailUrl: f.thumbnailId ? await resolveFileUrlFn(f.thumbnailId) : null,
    })));
    return { name: p.name, value: JSON.stringify(enriched) };
  }));
  return { ...lineItem, properties };
}

/** Human-scannable file list for the draft order's note, so the whole quote is readable without opening every line item's custom attributes. */
function buildFileSummaryLines(lineItems: QuoteLineItem[]): string[] {
  return lineItems.flatMap((li) => {
    const filesProp = li.properties.find((p) => p.name === "_files_json");
    if (!filesProp) return [];
    let files: Array<{ filename: string; fileUrl: string | null }>;
    try {
      files = JSON.parse(filesProp.value);
    } catch {
      return [];
    }
    return files.map((f) =>
      `  - ${f.filename}: ${f.fileUrl ?? "(still processing — check Shopify Files)"}`
    );
  });
}

function extractQuoteRef(lineItems: QuoteLineItem[]): string {
  return lineItems[0]?.properties.find((p) => p.name === "_quote_ref")?.value ?? "";
}

/**
 * Dependencies the router dispatches to. Exposed as a parameter (rather than
 * imported directly at call sites) so tests can substitute fakes without
 * fighting Deno's non-configurable ES module exports — see index.test.ts.
 */
export interface RelayDeps {
  getShopConfig: typeof getShopConfig;
  saveShopConfig: typeof saveShopConfig;
  uploadFile: typeof uploadFile;
  createPricedVariant: typeof createPricedVariant;
  createDraftOrder: typeof createDraftOrder;
  findOrCreateCustomer: typeof findOrCreateCustomer;
  resolveFileUrl: typeof resolveFileUrl;
  sendQuoteNotification: typeof sendQuoteNotification;
}

const defaultDeps: RelayDeps = {
  getShopConfig,
  saveShopConfig,
  uploadFile,
  createPricedVariant,
  createDraftOrder,
  findOrCreateCustomer,
  resolveFileUrl,
  sendQuoteNotification,
};

export async function handleRequest(
  req: Request,
  deps: RelayDeps = defaultDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const url = new URL(req.url);

    if (url.pathname.endsWith("/config") && req.method === "GET") {
      const config = await deps.getShopConfig();
      return json({ config });
    }

    if (url.pathname.endsWith("/config") && req.method === "POST") {
      const adminPassword = Deno.env.get("ADMIN_PASSWORD");
      if (!adminPassword || req.headers.get("x-admin-password") !== adminPassword) {
        return json({ error: "Unauthorized" }, 401);
      }
      const { config } = await readJsonBody(req);
      await deps.saveShopConfig(config);
      return json({ ok: true });
    }

    if (url.pathname.endsWith("/files") && req.method === "POST") {
      const { filename, mimeType, base64Data } = await readJsonBody(req);
      const file = await deps.uploadFile({ filename, mimeType, base64Data });
      return json(file);
    }

    if (url.pathname.endsWith("/checkout") && req.method === "POST") {
      const body = await readJsonBody(req) as {
        customerEmail: string;
        customerName: string;
        marketingConsent?: boolean;
        grandTotal: number;
        thresholdExceeded: boolean;
        lineItems: QuoteLineItem[];
      };

      // --- Server-side sanity checks on client-supplied pricing data ---
      // This endpoint is public and unauthenticated, so grandTotal and
      // thresholdExceeded cannot be trusted as-is: anyone can POST an
      // arbitrary total or clear the manual-review flag to bypass it.
      if (
        typeof body.grandTotal !== "number" ||
        !Number.isFinite(body.grandTotal) ||
        body.grandTotal <= 0
      ) {
        return json({ error: "Invalid grandTotal" }, 400);
      }
      if (!Array.isArray(body.lineItems) || body.lineItems.length === 0) {
        return json({ error: "Invalid lineItems" }, 400);
      }

      const computedTotal = body.lineItems.reduce(
        (sum, li) => sum + (Number(li.price) || 0) * (Number(li.quantity) || 0),
        0,
      );

      // Fetch shop config once, up front — used both to re-derive the
      // expected grandTotal (line items are priced BEFORE the whole-order
      // minimum is applied, so the frontend bumps grandTotal up to
      // minimumOrderTotal for small orders — see js/calculator.js's
      // calcOrderTotal) and for the manual-review threshold check below.
      const shopConfig = await deps.getShopConfig();
      const configuredMinimum =
        typeof shopConfig?.minimumOrderTotal === "number" ? shopConfig.minimumOrderTotal : 0;
      const expectedTotal = Math.max(computedTotal, configuredMinimum);

      // 1 cent tolerance for floating point drift, not a real fudge factor.
      if (Math.abs(expectedTotal - body.grandTotal) > 0.01) {
        return json({ error: "grandTotal does not match line items" }, 400);
      }

      // The client can force manual review (thresholdExceeded: true) but
      // cannot skip it — the server also checks the real threshold and
      // OR-combines the two.
      const configThreshold =
        typeof shopConfig?.customQuoteOrderThreshold === "number"
          ? shopConfig.customQuoteOrderThreshold
          : Infinity;
      const serverThresholdExceeded = Boolean(body.thresholdExceeded) ||
        body.grandTotal >= configThreshold;

      if (serverThresholdExceeded) {
        // 1. Find-or-create the customer, with GDPR-compliant marketing consent.
        const customer = await deps.findOrCreateCustomer({
          email: body.customerEmail,
          name: body.customerName,
          marketingConsent: Boolean(body.marketingConsent),
        });

        // 2. Resolve clickable file URLs for every uploaded STL/thumbnail
        //    referenced in the line items, so the draft order is
        //    self-contained for review (no need to hunt through Shopify's
        //    Files library by GID).
        const enrichedLineItems = await Promise.all(
          body.lineItems.map((li) => enrichLineItemWithFileUrls(li, deps.resolveFileUrl)),
        );

        // 3. Build the draft order — customer-linked, tagged, unsent.
        const quoteRef = extractQuoteRef(body.lineItems);
        const note = [
          `Quote ${quoteRef} for ${body.customerName} (${body.customerEmail}) — review before sending invoice.`,
          "",
          "Files:",
          ...buildFileSummaryLines(enrichedLineItems),
        ].join("\n");

        const { draftOrderId } = await deps.createDraftOrder({
          customerId: customer.id,
          note,
          tags: ["quote", `quote-ref:${quoteRef}`],
          lineItems: enrichedLineItems,
        });

        // 4. Best-effort notify the shop owner — never blocks/fails the quote.
        await deps.sendQuoteNotification({
          quoteRef,
          customerName: body.customerName,
          customerEmail: body.customerEmail,
          grandTotal: body.grandTotal,
          draftOrderId,
        });

        return json({ mode: "quote", quoteRef, draftOrderId });
      }

      const totalTitle = body.lineItems.map((li) => li.title).join(", ").slice(0, 250);
      const { variantId } = await deps.createPricedVariant({
        title: totalTitle || "Custom 3D Print",
        price: body.grandTotal.toFixed(2),
      });

      // v1 limitation: a single variant/cart-line is created for the whole
      // order, so only the first line item's properties (file ids, notes,
      // etc.) can travel with it — see docs/superpowers/plans/2026-08-02-shopify-integration.md.
      const properties: Record<string, string> = {};
      for (const p of body.lineItems[0]?.properties ?? []) {
        properties[p.name] = p.value;
      }

      return json({ mode: "cart", variantId, properties });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    if (err instanceof BadJsonError) {
      return json({ error: "Malformed JSON request body" }, 400);
    }
    // Don't leak internal details (shopifyGraphQL errors embed raw Shopify
    // response text) to the browser — log server-side, return a generic 500.
    console.error("shopify-relay: unhandled error", err);
    return json({ error: "Internal error" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd supabase/functions/shopify-relay && deno test index.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full relay test suite**

Run: `cd supabase/functions/shopify-relay && deno test`
Expected: PASS (every test file — `config.test.ts`, `customer.test.ts`, `draftOrder.test.ts`, `files.test.ts`, `index.test.ts`, `notify.test.ts`, `shopify.test.ts`, `variant.test.ts`)

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/shopify-relay/index.ts supabase/functions/shopify-relay/index.test.ts
git commit -m "Orchestrate the quote flow in /checkout: customer + draft order + notification"
```

---

### Task 7: Deploy the updated relay to Supabase

**Files:** none (deployment step, no code changes)

**Interfaces:**
- Consumes: the finished relay code from Tasks 1–6.
- Produces: the live relay at `https://aqnpkvzycdjwbapfpvfl.supabase.co/functions/v1/shopify-relay`, which Task 9's frontend changes will call.

- [ ] **Step 1: Deploy via the Supabase MCP connector's `deploy_edge_function` tool**, using the current contents of every file under `supabase/functions/shopify-relay/` (function name `shopify-relay`, `verify_jwt: false` to match the existing deployed config).

- [ ] **Step 2: Verify the deploy succeeded**

Run (from any shell with internet access):
```bash
curl -s https://aqnpkvzycdjwbapfpvfl.supabase.co/functions/v1/shopify-relay/config
```
Expected: a JSON response (either `{"config":null}` or `{"config":{...}}`) — not a 500 or a deploy-error page. This confirms the new code booted successfully (a syntax error or bad import would 500 here).

- [ ] **Step 3: Note the still-missing secret**

`RESEND_API_KEY` (and optionally `NOTIFY_TO_EMAIL`/`RESEND_FROM_EMAIL` if overriding the defaults) is **not yet set** on the deployed function — that requires a Resend account and a verified sending domain, which only the user can create. Until it's set, quotes will still work end-to-end (customer + draft order creation is unaffected), just silently skipping the notification email (per Task 4's designed fallback). Flag this clearly to the user; do not block on it.

---

### Task 8: Shopify theme frontend — GDPR consent checkbox markup

**Files:**
- Modify: `shopify-theme/snippets/print-calculator-markup.liquid`

**Interfaces:**
- Produces: two new elements in the DOM — `#marketing-consent-block` (wrapper, hidden by default via inline `style="display:none"`, shown by Task 9's JS when the quote threshold is crossed) containing `#marketing-consent-check` (the checkbox itself, name `marketing-consent`). Consumed by Task 9.

- [ ] **Step 1: Add the consent block to the contact-form step**

In `shopify-theme/snippets/print-calculator-markup.liquid`, find this existing block (inside `<form id="order-form" novalidate>`, right after the `cust-notes` `form-field` div and before the `disclaimer-field` div):
```html
          <div class="form-field">
            <label for="cust-notes">Additional notes</label>
            <textarea id="cust-notes" name="cust-notes"
              placeholder="Colour preferences, deadline, special requirements…"></textarea>
          </div>

          <div class="form-field disclaimer-field">
```

Replace it with (adds the new consent block between notes and the disclaimer):
```html
          <div class="form-field">
            <label for="cust-notes">Additional notes</label>
            <textarea id="cust-notes" name="cust-notes"
              placeholder="Colour preferences, deadline, special requirements…"></textarea>
          </div>

          <div class="form-field marketing-consent-block" id="marketing-consent-block" style="display:none">
            <p class="consent-note">We'll only use your name and email to send you this quote and follow up on your order — it won't be added to any marketing list unless you tick below.</p>
            <label class="checkbox-row">
              <input type="checkbox" name="marketing-consent" id="marketing-consent-check">
              <span>Also send me offers and news from Arcane Flame</span>
            </label>
          </div>

          <div class="form-field disclaimer-field">
```

- [ ] **Step 2: Commit**

```bash
git add shopify-theme/snippets/print-calculator-markup.liquid
git commit -m "Add GDPR marketing-consent checkbox markup to the quote contact form"
```

---

### Task 9: Shopify theme frontend — wire up consent, new response handling

**Files:**
- Modify: `shopify-theme/assets/print-calc-main.js`

**Interfaces:**
- Consumes: `#marketing-consent-block`/`#marketing-consent-check` from Task 8; the new `/checkout` response shape `{ mode: "quote", quoteRef, draftOrderId }` from Task 6.
- Produces: on submit, POSTs `marketingConsent: boolean` in the `/checkout` request body; on `mode === "quote"`, shows the existing (previously-dead) `#order-success-wrap` step instead of navigating anywhere.

- [ ] **Step 1: Show/hide the consent block alongside the existing quote-threshold note**

In `shopify-theme/assets/print-calc-main.js`, find this block inside `openOrderForm()`:
```js
  const quoteNoteEl = document.getElementById('review-custom-quote-note');
  if (quoteNoteEl) quoteNoteEl.style.display = exceedsCustomQuoteThreshold(grandTotal, config) ? 'block' : 'none';
```

Replace it with:
```js
  const isQuote = exceedsCustomQuoteThreshold(grandTotal, config);
  const quoteNoteEl = document.getElementById('review-custom-quote-note');
  if (quoteNoteEl) quoteNoteEl.style.display = isQuote ? 'block' : 'none';
  const marketingBlockEl = document.getElementById('marketing-consent-block');
  if (marketingBlockEl) marketingBlockEl.style.display = isQuote ? 'block' : 'none';
```

- [ ] **Step 2: Read the consent checkbox and send it in the request body**

Find this block inside `submitOrder()`:
```js
  const name       = form.querySelector('[name="cust-name"]').value.trim();
  const email      = form.querySelector('[name="cust-email"]').value.trim();
  const notes      = form.querySelector('[name="cust-notes"]').value.trim();
  const disclaimer = form.querySelector('[name="disclaimer"]').checked;
```

Replace it with:
```js
  const name             = form.querySelector('[name="cust-name"]').value.trim();
  const email            = form.querySelector('[name="cust-email"]').value.trim();
  const notes            = form.querySelector('[name="cust-notes"]').value.trim();
  const disclaimer       = form.querySelector('[name="disclaimer"]').checked;
  const marketingConsent = form.querySelector('[name="marketing-consent"]')?.checked ?? false;
```

Find this block (the `fetch(...)` call's body):
```js
  fetch(`${RELAY_BASE_URL}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerEmail: email,
      customerName: name,
      grandTotal,
      thresholdExceeded,
      lineItems,
    }),
  })
```

Replace it with:
```js
  fetch(`${RELAY_BASE_URL}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerEmail: email,
      customerName: name,
      marketingConsent,
      grandTotal,
      thresholdExceeded,
      lineItems,
    }),
  })
```

- [ ] **Step 3: Replace the redirect-on-draft-order handling with the in-page success screen**

Find this block (the `.then(result => {...})` handler):
```js
    .then(result => {
      if (result.mode === 'draft-order') {
        window.location.href = result.invoiceUrl;
        return;
      }
      // mode === 'cart' — add the priced variant to the real Shopify cart, then go to checkout.
```

Replace it with:
```js
    .then(result => {
      if (result.mode === 'quote') {
        showQuoteSuccess(email);
        return;
      }
      // mode === 'cart' — add the priced variant to the real Shopify cart, then go to checkout.
```

- [ ] **Step 4: Add the `showQuoteSuccess` function**

Add this new function immediately after `submitOrder`'s closing brace (i.e. right after the `}` that ends the `async function submitOrder(e) { ... }` block, before the `// ---- Utilities` comment):
```js

/** Shows the success step in place — no navigation. `mode === 'quote'` never redirects the customer anywhere (no payment page, since the order is a draft awaiting manual review). */
function showQuoteSuccess(email) {
  const emailEl  = document.getElementById('order-success-email');
  if (emailEl) emailEl.textContent = email;
  const numberEl = document.getElementById('order-success-number');
  if (numberEl) numberEl.textContent = _orderNumber ?? '—';

  document.getElementById('order-review-wrap').style.display  = 'none';
  document.getElementById('order-form-wrap').style.display    = 'none';
  document.getElementById('order-success-wrap').style.display = 'flex';
  document.querySelector('.order-panel')?.scrollTo(0, 0);
}
```

- [ ] **Step 5: Commit**

```bash
git add shopify-theme/assets/print-calc-main.js
git commit -m "Wire up marketing consent + show in-page success screen for quote mode (no more redirect)"
```

---

### Task 10: Shopify theme frontend — style the consent block

**Files:**
- Modify: `shopify-theme/assets/print-calc-style.css`

**Interfaces:** none (pure styling, no new selectors consumed elsewhere).

- [ ] **Step 1: Add `.consent-note` styling**

In `shopify-theme/assets/print-calc-style.css`, find this existing rule (in the `.disclaimer-field` section):
```css
.disclaimer-field {
  background: rgba(28,109,87,.04); border: 1px solid rgba(28,109,87,.18);
  border-radius: var(--radius-sm); padding: 12px 14px; margin-bottom: 16px;
}
```

Add this new rule immediately before it:
```css
.marketing-consent-block { margin-bottom: 16px; }
.consent-note {
  font-size: .78em; color: var(--text-dim); line-height: 1.5; margin-bottom: 8px;
}

.disclaimer-field {
  background: rgba(28,109,87,.04); border: 1px solid rgba(28,109,87,.18);
  border-radius: var(--radius-sm); padding: 12px 14px; margin-bottom: 16px;
}
```

- [ ] **Step 2: Commit**

```bash
git add shopify-theme/assets/print-calc-style.css
git commit -m "Style the GDPR marketing-consent note and checkbox"
```

---

### Task 11: Deploy the updated theme files to the fresh preview theme

**Files:** none (deployment step)

**Interfaces:**
- Consumes: Tasks 8–10's finished frontend files.

- [ ] **Step 1: Upload the three changed files** (`shopify-theme/snippets/print-calculator-markup.liquid`, `shopify-theme/assets/print-calc-main.js`, `shopify-theme/assets/print-calc-style.css`) to theme `gid://shopify/OnlineStoreTheme/196711055704` via the Shopify connector's `themeFilesUpsert` GraphQL mutation, using each file's exact current on-disk content as the `TEXT` body — same pattern used throughout this session's earlier theme uploads.

- [ ] **Step 2: Verify in the browser preview**

Navigate to `https://arcane-flame.com/pages/3d-print-calculator?preview_theme_id=196711055704`, upload a real STL test file large/many enough to cross the £150 threshold, proceed to "Request a Quote" → contact form, and confirm:
- The GDPR consent note + unticked checkbox appear (only for this over-threshold case).
- Submitting (with name + email + disclaimer ticked, consent checkbox left unticked) shows the in-page "Quote Submitted!" success screen — the browser does **not** navigate away.
- In Shopify Admin: a new customer exists with the submitted email and `emailMarketingConsent.marketingState` = `NOT_SUBSCRIBED`; a new draft order exists, linked to that customer, tagged `quote` and `quote-ref:<ref>`, status unsent, with the file's resolved URL (or a "still processing" fallback note) visible in its note.
- Repeat once more with the consent checkbox **ticked** and confirm that customer's `emailMarketingConsent.marketingState` = `SUBSCRIBED`.

- [ ] **Step 3: Update the progress ledger**

Append a new section to `.superpowers/sdd/progress.md` documenting: quote workflow rebuilt (customer creation, draft order, GDPR consent, file URL resolution, Resend notification — best-effort, pending `RESEND_API_KEY`), verified end-to-end in the preview theme, theme `196711055704` still needs manual publish by the user (per the existing Task 11 note already in that file).

---

### Task 12: Mirror the frontend changes into the standalone tool

**Files:**
- Modify: `index.html`
- Modify: `js/main.js`

**Interfaces:** none new — mirrors Tasks 8–9's behavior into the parallel standalone codebase.

- [ ] **Step 1: Add the consent block to `index.html`**

In `index.html`, find this existing block (same location as Task 8, inside `<form id="order-form" novalidate>`):
```html
          <div class="form-field">
            <label for="cust-notes">Additional notes</label>
            <textarea id="cust-notes" name="cust-notes"
              placeholder="Colour preferences, deadline, special requirements…"></textarea>
          </div>

          <div class="form-field disclaimer-field">
```

Replace it with:
```html
          <div class="form-field">
            <label for="cust-notes">Additional notes</label>
            <textarea id="cust-notes" name="cust-notes"
              placeholder="Colour preferences, deadline, special requirements…"></textarea>
          </div>

          <div class="form-field marketing-consent-block" id="marketing-consent-block" style="display:none">
            <p class="consent-note">We'll only use your name and email to send you this quote and follow up on your order — it won't be added to any marketing list unless you tick below.</p>
            <label class="checkbox-row">
              <input type="checkbox" name="marketing-consent" id="marketing-consent-check">
              <span>Also send me offers and news from Arcane Flame</span>
            </label>
          </div>

          <div class="form-field disclaimer-field">
```

- [ ] **Step 2: Apply the same three JS edits from Task 9 to `js/main.js`**

Apply the identical replacements from Task 9 Steps 1–4 to `js/main.js` (the `openOrderForm` consent-visibility block, the `submitOrder` field-reading block, the `fetch(...)` body, the `.then(result => {...})` handler, and the new `showQuoteSuccess` function) — the surrounding code is identical between the two files except for import paths, so the same before/after snippets apply verbatim.

- [ ] **Step 3: Add the `.consent-note`/`.marketing-consent-block` CSS to `css/style.css`**

Find the equivalent `.disclaimer-field` rule in `css/style.css` and apply the same insertion from Task 10 Step 1.

- [ ] **Step 4: Commit**

```bash
git add index.html js/main.js css/style.css
git commit -m "Mirror GDPR consent + quote success-screen changes into the standalone tool"
```

---

### Task 13: Final full verification pass

**Files:** none

- [ ] **Step 1: Run the full relay test suite one more time**

Run: `cd supabase/functions/shopify-relay && deno test`
Expected: PASS, every file.

- [ ] **Step 2: Confirm no leftover references to the old response shape**

Run: `grep -rn "draft-order\|invoiceUrl" shopify-theme/ js/ index.html supabase/functions/shopify-relay/*.ts`
Expected: no matches (the old `mode: "draft-order"` / `invoiceUrl` shape should be fully gone from both frontend and backend — only test files and this plan itself may still mention it as historical context, which is fine).

- [ ] **Step 3: Summarize outstanding user actions**

Report back clearly (do not attempt to complete these — they require accounts only the user can create):
1. Sign up for Resend, verify a sending domain, generate an API key.
2. Add `RESEND_API_KEY` (and `NOTIFY_TO_EMAIL`/`RESEND_FROM_EMAIL` if different from the defaults) as Supabase Edge Function secrets, the same way `SHOPIFY_CLIENT_ID` etc. were added.
3. Manually publish theme `196711055704` in Shopify Admin when ready to go live (still blocked on this from the earlier Task 11 in `.superpowers/sdd/progress.md` — unchanged by this plan).
