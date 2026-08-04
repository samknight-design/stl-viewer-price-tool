# Shopify Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing static STL price calculator into the Arcane Flame Shopify store end-to-end — instant Add-to-Cart checkout at the exact calculated price, orders ≥£150 routed to manual-review Draft Orders, and every uploaded STL + its thumbnail stored natively in Shopify and linked to the resulting order, ready for a future packing/sorting tool to read.

**Architecture:** The frontend stays a static, dependency-free page (as it is today) embedded directly into the Shopify theme. It talks to exactly one new piece of infrastructure — a stateless Supabase Edge Function ("the relay") that is the only thing holding the Shopify Admin API secret. The relay has no database of its own: pricing config lives in a Shopify **shop metafield**, uploaded files live in **Shopify Files**, and the link between an order and its files rides along as **cart/order line-item properties** (which Shopify carries automatically from cart → order, so no separate lookup table is ever needed).

**Tech Stack:** Vanilla JS frontend (unchanged), Supabase Edge Functions (Deno/TypeScript) for the relay, Shopify Admin GraphQL API (2025-01 or later — confirm current stable version at build time), Shopify Online Store 2.0 theme (Basic/Grow plan).

## Global Constraints

- No new database. Shopify is the sole source of truth for config, files, and order data. Supabase is used **only** as a host for the relay function's compute — it stores no persistent business data.
- The relay is the only place the `SHOPIFY_ADMIN_API_TOKEN` secret exists. It must never reach the browser.
- Orders where `grandTotal >= config.customQuoteOrderThreshold` (currently £150) skip instant Add-to-Cart and are created as Shopify Draft Orders instead, for manual review before the customer pays.
- Admin panel password check happens server-side in the relay (`ADMIN_PASSWORD` as a relay secret), never compared in browser JS.
- The existing frontend architecture (no build step, no framework, `?v=N` cache-busting on every JS/CSS file) is preserved — this plan adds relay calls to existing files, it does not rewrite them into a framework.
- Every file/thumbnail uploaded to Shopify must be discoverable later purely from `order.lineItems[].customAttributes` (or `properties` in the Storefront Cart API) — no separate database keyed by quote reference. This is what makes the future packing tool possible without building it now.
- STL file uploads happen as soon as a part is added to a model (not batched at checkout) — smoother perceived performance, matches the app's existing "render immediately" UX. Known tradeoff: a customer who adds then removes a part before checkout leaves an orphaned file in Shopify Files. Acceptable — cleanup is a future nice-to-have, not part of this plan.
- Do **not** build the packing/sorting tool in this plan. Only make sure the data it will need (thumbnail + STL file references per order line item) exists in Shopify by the time this plan is done.

---

## Part 1 — Supabase relay function

### Task 1: Supabase project setup and secrets

**Files:**
- Create: `supabase/functions/shopify-relay/deno.json`
- Create: `supabase/functions/shopify-relay/.env.example`

**Interfaces:**
- Produces: environment variables every later task reads — `SHOPIFY_STORE_DOMAIN` (e.g. `arcane-flame.myshopify.com`), `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_API_VERSION` (e.g. `2025-01`), `ADMIN_PASSWORD`, `PRINT_PRODUCT_ID` (the numeric ID of the hidden "Custom 3D Print" product created in Task 2).

- [x] **Step 1: Create the Supabase project (if one doesn't already exist for this)** — DONE. User created project `aqnpkvzycdjwbapfpvfl` (eu-west-1, Arcane-Flame-Software org). Relay deployed and live at `https://aqnpkvzycdjwbapfpvfl.supabase.co/functions/v1/shopify-relay` via the Supabase MCP's `deploy_edge_function` tool (no CLI auth needed). `js/config.js`'s `RELAY_BASE_URL` updated to match, verified reachable.

- [x] **Step 2: Create a Shopify app for Admin API access** — DONE, but the mechanism changed from the original plan, and took several failed attempts to get right. Shopify's legacy "Develop apps" static-token flow was not reachable for this store — even the store Admin's own "Develop apps" link now routes into the same newer Dev Dashboard app model, which does not surface a static `shpat_` token at all; it only offers OAuth-style Client ID/Client Secret via the client-credentials grant. Two earlier apps (`print-calculator-relay`, `stil-tool-relay`) were created and abandoned because their installs silently failed — clicking "Install app" redirected straight to the App URL with no consent screen shown, and the client-credentials grant kept failing with `app_not_installed`. What finally worked: a fresh app (`stl-calculator`) with **"Embed app in Shopify admin" unchecked**, **"Use legacy install flow" unchecked**, and both **App URL and Redirect URL pointed at the real, live relay** (not a placeholder like `example.com`) — this made Shopify show a genuine consent/permissions screen before redirecting, and installing after that screen actually registered. `shopify.ts` exchanges the resulting Client ID/Secret for a short-lived (24h) access token via `POST https://{domain}/admin/oauth/access_token` with `grant_type: client_credentials`, caching and auto-refreshing it in memory (see Task 3 below — `SHOPIFY_ADMIN_API_TOKEN` is replaced by `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`). Verified live: token exchange succeeds, `GET /config` returns 200. Required scopes configured on the app's Configuration page:
- `write_products`, `read_products` (create the priced variant)
- `write_files`, `read_files` (upload STL + thumbnail)
- `write_draft_orders`, `read_draft_orders` (£150+ manual-review path)
- `write_orders`, `read_orders` (optional now, needed by the future packing tool)
- `write_metaobjects` is not needed — using a shop metafield, not a metaobject.

- [x] **Step 3: Create the hidden "Custom 3D Print" product** — DONE. Created via the Shopify MCP connector's `create-product` tool: title "Custom 3D Print (do not edit)", status Draft, default variant £0.00. `PRINT_PRODUCT_ID = 15907078340952`.

- [x] **Step 4: Write `deno.json`**

```json
{
  "imports": {
    "std/": "https://deno.land/std@0.224.0/"
  }
}
```

- [x] **Step 5: Write `.env.example` documenting required secrets (not the real values)**

```bash
SHOPIFY_STORE_DOMAIN=arcane-flame.myshopify.com
SHOPIFY_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_CLIENT_SECRET=shpss_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_VERSION=2025-01
ADMIN_PASSWORD=change-me
PRINT_PRODUCT_ID=1234567890
```

- [x] **Step 6: Set the real secrets on the Supabase project** — DONE via the Supabase dashboard's Edge Function Secrets UI (bulk `KEY=VALUE` paste into the **Name** field auto-splits into separate secrets — pasting into the Value field instead collapses everything into one wrongly-named secret, a mistake made and corrected once). All 6 secrets set; verified live.

```bash
supabase secrets set --project-ref <project-ref> \
  SHOPIFY_STORE_DOMAIN=arcane-flame.myshopify.com \
  SHOPIFY_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  SHOPIFY_CLIENT_SECRET=shpss_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  SHOPIFY_API_VERSION=2025-01 \
  ADMIN_PASSWORD=<a real strong password, not admin123> \
  PRINT_PRODUCT_ID=1234567890
```

- [x] **Step 7: Commit** — DONE (deno.json/.env.example committed alongside Task 2, then updated again in commit `69c6a86` for the client-credentials switch).

```bash
git add supabase/functions/shopify-relay/deno.json supabase/functions/shopify-relay/.env.example
git commit -m "Scaffold Supabase relay function for Shopify integration"
```

---

### Task 2: Shopify Admin API GraphQL helper

**Files:**
- Create: `supabase/functions/shopify-relay/shopify.ts`
- Test: `supabase/functions/shopify-relay/shopify.test.ts`

**Interfaces:**
- Consumes: `Deno.env.get('SHOPIFY_STORE_DOMAIN')`, `Deno.env.get('SHOPIFY_ADMIN_API_TOKEN')`, `Deno.env.get('SHOPIFY_API_VERSION')`
- Produces: `shopifyGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T>` — every later task calls this exclusively rather than hand-rolling fetch calls.

> **Deviation (2026-08-02):** the code sample below is the original, now-superseded version. Shopify's Dev Dashboard app model doesn't issue a static `SHOPIFY_ADMIN_API_TOKEN` — only a Client ID/Client Secret for the OAuth client-credentials grant. `shopify.ts` was updated to consume `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` instead, exchange them for a short-lived token via `POST /admin/oauth/access_token`, and cache/refresh it in memory (`getAccessToken()`, `__resetTokenCacheForTests()`). `shopify.test.ts`, `config.test.ts`, and `files.test.ts` were updated to mock the extra token-exchange call. All 29 relay tests pass after the change.

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-env supabase/functions/shopify-relay/shopify.test.ts`
Expected: FAIL — `shopify.ts` doesn't exist yet, module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// supabase/functions/shopify-relay/shopify.ts
const STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN")!;
const ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_API_TOKEN")!;
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-01";

export async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(
    `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!res.ok) {
    throw new Error(`Shopify Admin API HTTP ${res.status}: ${await res.text()}`);
  }

  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(body.errors.map((e: { message: string }) => e.message).join("; "));
  }
  if (body.data && Object.values(body.data).some(
    (v: any) => v?.userErrors?.length,
  )) {
    const userErrors = Object.values(body.data)
      .flatMap((v: any) => v?.userErrors ?? [])
      .map((e: { field: string[]; message: string }) => `${e.field?.join(".")}: ${e.message}`);
    if (userErrors.length) throw new Error(`Shopify mutation error: ${userErrors.join("; ")}`);
  }

  return body.data as T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-env supabase/functions/shopify-relay/shopify.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shopify-relay/shopify.ts supabase/functions/shopify-relay/shopify.test.ts
git commit -m "Add Shopify Admin GraphQL client for relay function"
```

---

### Task 3: Config read/write via shop metafield (replaces localStorage)

**Files:**
- Create: `supabase/functions/shopify-relay/config.ts`
- Test: `supabase/functions/shopify-relay/config.test.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL` from Task 2.
- Produces: `getShopConfig(): Promise<Record<string, unknown> | null>`, `saveShopConfig(config: Record<string, unknown>): Promise<void>`. Task 8 (router) exposes these as `GET/POST /config`.

- [ ] **Step 1: Write the failing test**

```typescript
// supabase/functions/shopify-relay/config.test.ts
import { assertEquals } from "std/testing/asserts.ts";
import { stub } from "std/testing/mock.ts";
import * as shopifyModule from "./shopify.ts";
import { getShopConfig, saveShopConfig } from "./config.ts";

Deno.test("getShopConfig returns null when metafield unset", async () => {
  const s = stub(shopifyModule, "shopifyGraphQL", () =>
    Promise.resolve({ shop: { metafield: null } } as never));
  try {
    const config = await getShopConfig();
    assertEquals(config, null);
  } finally {
    s.restore();
  }
});

Deno.test("getShopConfig parses stored JSON", async () => {
  const s = stub(shopifyModule, "shopifyGraphQL", () =>
    Promise.resolve({
      shop: { metafield: { value: JSON.stringify({ minimumOrderTotal: 5 }) } },
    } as never));
  try {
    const config = await getShopConfig();
    assertEquals(config, { minimumOrderTotal: 5 });
  } finally {
    s.restore();
  }
});

Deno.test("saveShopConfig calls metafieldsSet with serialized JSON", async () => {
  let capturedVariables: Record<string, unknown> | undefined;
  const s = stub(shopifyModule, "shopifyGraphQL", (_q: string, vars?: Record<string, unknown>) => {
    capturedVariables = vars;
    return Promise.resolve({ metafieldsSet: { userErrors: [] } } as never);
  });
  try {
    await saveShopConfig({ minimumOrderTotal: 5 });
    const metafields = capturedVariables?.metafields as Array<{ value: string }>;
    assertEquals(JSON.parse(metafields[0].value), { minimumOrderTotal: 5 });
  } finally {
    s.restore();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-env supabase/functions/shopify-relay/config.test.ts`
Expected: FAIL — `config.ts` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// supabase/functions/shopify-relay/config.ts
import { shopifyGraphQL } from "./shopify.ts";

const NAMESPACE = "print_calculator";
const KEY = "pricing_config";

const GET_QUERY = `
  query GetPricingConfig {
    shop {
      metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
        value
      }
    }
  }
`;

export async function getShopConfig(): Promise<Record<string, unknown> | null> {
  const data = await shopifyGraphQL<{ shop: { metafield: { value: string } | null } }>(
    GET_QUERY,
  );
  if (!data.shop.metafield) return null;
  return JSON.parse(data.shop.metafield.value);
}

const SET_MUTATION = `
  mutation SavePricingConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

export async function saveShopConfig(config: Record<string, unknown>): Promise<void> {
  const shopGid = await getShopGid();
  await shopifyGraphQL(SET_MUTATION, {
    metafields: [
      {
        ownerId: shopGid,
        namespace: NAMESPACE,
        key: KEY,
        type: "json",
        value: JSON.stringify(config),
      },
    ],
  });
}

async function getShopGid(): Promise<string> {
  const data = await shopifyGraphQL<{ shop: { id: string } }>(`query { shop { id } }`);
  return data.shop.id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-env supabase/functions/shopify-relay/config.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shopify-relay/config.ts supabase/functions/shopify-relay/config.test.ts
git commit -m "Store pricing config in a Shopify shop metafield instead of localStorage"
```

---

### Task 4: File upload to Shopify Files (STL + thumbnail)

**Files:**
- Create: `supabase/functions/shopify-relay/files.ts`
- Test: `supabase/functions/shopify-relay/files.test.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL` from Task 2.
- Produces: `uploadFile(input: { filename: string; mimeType: string; base64Data: string }): Promise<{ id: string; url: string }>`. Task 8 (router) exposes this as `POST /files`. Task 5 consumes the returned `id` (a `gid://shopify/GenericFile/...` or `gid://shopify/MediaImage/...`) to attach to cart line-item properties.

- [ ] **Step 1: Write the failing test**

```typescript
// supabase/functions/shopify-relay/files.test.ts
import { assertEquals } from "std/testing/asserts.ts";
import { stub } from "std/testing/mock.ts";
import * as shopifyModule from "./shopify.ts";
import { uploadFile } from "./files.ts";

Deno.test("uploadFile stages, PUTs bytes, then calls fileCreate", async () => {
  const calls: string[] = [];
  const graphqlStub = stub(shopifyModule, "shopifyGraphQL", (query: string) => {
    if (query.includes("stagedUploadsCreate")) {
      calls.push("stage");
      return Promise.resolve({
        stagedUploadsCreate: {
          stagedTargets: [{
            url: "https://shopify-staged-uploads.example/put-here",
            resourceUrl: "https://shopify-staged-uploads.example/resource",
            parameters: [{ name: "key", value: "tmp/abc" }],
          }],
          userErrors: [],
        },
      } as never);
    }
    if (query.includes("fileCreate")) {
      calls.push("create");
      return Promise.resolve({
        fileCreate: {
          files: [{ id: "gid://shopify/GenericFile/999", preview: { image: { url: "https://cdn.example/f.png" } } }],
          userErrors: [],
        },
      } as never);
    }
    throw new Error("unexpected query: " + query);
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push("put:" + url);
    return Promise.resolve(new Response("", { status: 201 }));
  };
  try {
    const result = await uploadFile({
      filename: "part.stl",
      mimeType: "model/stl",
      base64Data: btoa("fake stl bytes"),
    });
    assertEquals(result.id, "gid://shopify/GenericFile/999");
    assertEquals(calls[0], "stage");
    assertEquals(calls[1].startsWith("put:"), true);
    assertEquals(calls[2], "create");
  } finally {
    graphqlStub.restore();
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-env supabase/functions/shopify-relay/files.test.ts`
Expected: FAIL — `files.ts` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// supabase/functions/shopify-relay/files.ts
import { shopifyGraphQL } from "./shopify.ts";

const STAGE_MUTATION = `
  mutation StageUpload($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE_MUTATION = `
  mutation CreateFile($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        preview { image { url } }
      }
      userErrors { field message }
    }
  }
`;

interface UploadFileInput {
  filename: string;
  mimeType: string;
  /** Raw file bytes, base64-encoded (frontend sends this over JSON). */
  base64Data: string;
}

export async function uploadFile(
  input: UploadFileInput,
): Promise<{ id: string; url: string | null }> {
  const bytes = Uint8Array.from(atob(input.base64Data), (c) => c.charCodeAt(0));

  const staged = await shopifyGraphQL<{
    stagedUploadsCreate: {
      stagedTargets: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }>;
    };
  }>(STAGE_MUTATION, {
    input: [{
      filename: input.filename,
      mimeType: input.mimeType,
      httpMethod: "POST",
      resource: input.mimeType.startsWith("image/") ? "IMAGE" : "FILE",
    }],
  });

  const target = staged.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([bytes], { type: input.mimeType }), input.filename);

  const putRes = await fetch(target.url, { method: "POST", body: form });
  if (!putRes.ok) {
    throw new Error(`Staged upload PUT failed: HTTP ${putRes.status}`);
  }

  const created = await shopifyGraphQL<{
    fileCreate: {
      files: Array<{ id: string; preview: { image: { url: string } | null } | null }>;
    };
  }>(FILE_CREATE_MUTATION, {
    files: [{
      alt: input.filename,
      contentType: input.mimeType.startsWith("image/") ? "IMAGE" : "FILE",
      originalSource: target.resourceUrl,
    }],
  });

  const file = created.fileCreate.files[0];
  return { id: file.id, url: file.preview?.image?.url ?? null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-env supabase/functions/shopify-relay/files.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shopify-relay/files.ts supabase/functions/shopify-relay/files.test.ts
git commit -m "Add Shopify Files upload (staged upload + fileCreate) to relay"
```

---

### Task 5: Priced variant creation (instant Add-to-Cart path)

**Files:**
- Create: `supabase/functions/shopify-relay/variant.ts`
- Test: `supabase/functions/shopify-relay/variant.test.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL` from Task 2, `Deno.env.get('PRINT_PRODUCT_ID')`.
- Produces: `createPricedVariant(input: { title: string; price: string }): Promise<{ variantId: number }>` — a plain numeric Shopify variant ID, exactly what the Storefront `/cart/add.js` endpoint's `id` field expects. Task 8 exposes this as `POST /variant`.

- [ ] **Step 1: Write the failing test**

```typescript
// supabase/functions/shopify-relay/variant.test.ts
import { assertEquals } from "std/testing/asserts.ts";
import { stub } from "std/testing/mock.ts";
import * as shopifyModule from "./shopify.ts";
import { createPricedVariant } from "./variant.ts";

Deno.test("createPricedVariant returns the numeric variant id", async () => {
  const s = stub(shopifyModule, "shopifyGraphQL", () =>
    Promise.resolve({
      productVariantsBulkCreate: {
        productVariants: [{ id: "gid://shopify/ProductVariant/44556677" }],
        userErrors: [],
      },
    } as never));
  try {
    const result = await createPricedVariant({ title: "Quote AF-20260802-ABCD", price: "17.68" });
    assertEquals(result.variantId, 44556677);
  } finally {
    s.restore();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-env supabase/functions/shopify-relay/variant.test.ts`
Expected: FAIL — `variant.ts` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// supabase/functions/shopify-relay/variant.ts
import { shopifyGraphQL } from "./shopify.ts";

const PRODUCT_ID = Deno.env.get("PRINT_PRODUCT_ID")!;

const CREATE_VARIANT_MUTATION = `
  mutation CreatePricedVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

interface CreatePricedVariantInput {
  /** Shown on the order line — put the model/quote name here. */
  title: string;
  /** Decimal string, e.g. "17.68" — must match calcOrderTotal's currency precision. */
  price: string;
}

export async function createPricedVariant(
  input: CreatePricedVariantInput,
): Promise<{ variantId: number }> {
  const data = await shopifyGraphQL<{
    productVariantsBulkCreate: { productVariants: Array<{ id: string }> };
  }>(CREATE_VARIANT_MUTATION, {
    productId: `gid://shopify/Product/${PRODUCT_ID}`,
    variants: [{
      price: input.price,
      optionValues: [{ optionName: "Title", name: input.title }],
      inventoryPolicy: "CONTINUE",
    }],
  });

  const gid = data.productVariantsBulkCreate.productVariants[0].id;
  const variantId = Number(gid.split("/").pop());
  return { variantId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-env supabase/functions/shopify-relay/variant.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shopify-relay/variant.ts supabase/functions/shopify-relay/variant.test.ts
git commit -m "Add per-quote priced variant creation to relay"
```

---

### Task 6: Draft Order creation (£150+ manual-review path)

**Files:**
- Create: `supabase/functions/shopify-relay/draftOrder.ts`
- Test: `supabase/functions/shopify-relay/draftOrder.test.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL` from Task 2. Same `QuoteLineItem` shape as Task 7 defines (see Task 7's `QuoteLineItem` type — this task is written against that same interface so the router in Task 8 can pass either path the same payload).
- Produces: `createDraftOrder(input: { customerEmail: string; customerName: string; lineItems: QuoteLineItem[] }): Promise<{ invoiceUrl: string }>`. Task 8 exposes this as `POST /draft-order`.

- [ ] **Step 1: Write the failing test**

```typescript
// supabase/functions/shopify-relay/draftOrder.test.ts
import { assertEquals } from "std/testing/asserts.ts";
import { stub } from "std/testing/mock.ts";
import * as shopifyModule from "./shopify.ts";
import { createDraftOrder } from "./draftOrder.ts";

Deno.test("createDraftOrder returns the invoice URL", async () => {
  const s = stub(shopifyModule, "shopifyGraphQL", () =>
    Promise.resolve({
      draftOrderCreate: {
        draftOrder: { invoiceUrl: "https://arcane-flame.myshopify.com/123/invoices/abc" },
        userErrors: [],
      },
    } as never));
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
    s.restore();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-env supabase/functions/shopify-relay/draftOrder.test.ts`
Expected: FAIL — `draftOrder.ts` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// supabase/functions/shopify-relay/draftOrder.ts
import { shopifyGraphQL } from "./shopify.ts";

export interface QuoteLineItem {
  title: string;
  /** Decimal string, e.g. "180.00" */
  price: string;
  quantity: number;
  properties: Array<{ name: string; value: string }>;
}

const CREATE_DRAFT_ORDER_MUTATION = `
  mutation CreateDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { invoiceUrl }
      userErrors { field message }
    }
  }
`;

export async function createDraftOrder(input: {
  customerEmail: string;
  customerName: string;
  lineItems: QuoteLineItem[];
}): Promise<{ invoiceUrl: string }> {
  const data = await shopifyGraphQL<{
    draftOrderCreate: { draftOrder: { invoiceUrl: string } };
  }>(CREATE_DRAFT_ORDER_MUTATION, {
    input: {
      email: input.customerEmail,
      note2: `Custom quote for ${input.customerName} — over the auto-checkout threshold, review before sending invoice.`,
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
  return { invoiceUrl: data.draftOrderCreate.draftOrder.invoiceUrl };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-env supabase/functions/shopify-relay/draftOrder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shopify-relay/draftOrder.ts supabase/functions/shopify-relay/draftOrder.test.ts
git commit -m "Add Draft Order creation to relay for orders over the review threshold"
```

---

### Task 7: HTTP router tying the relay together

**Files:**
- Create: `supabase/functions/shopify-relay/index.ts`
- Test: `supabase/functions/shopify-relay/index.test.ts`

**Interfaces:**
- Consumes: `getShopConfig`/`saveShopConfig` (Task 3), `uploadFile` (Task 4), `createPricedVariant` (Task 5), `createDraftOrder` + `QuoteLineItem` (Task 6).
- Produces: the deployed HTTP surface every frontend task (9, 10, 11) calls:
  - `GET /config` → `{ config: object | null }`
  - `POST /config` with header `x-admin-password` and body `{ config: object }` → `{ ok: true }` or `401`
  - `POST /files` with body `{ filename, mimeType, base64Data }` → `{ id, url }`
  - `POST /checkout` with body `{ customerEmail, customerName, grandTotal, thresholdExceeded, lineItems: QuoteLineItem[] }` → either `{ mode: "cart", variantId }` or `{ mode: "draft-order", invoiceUrl }`

- [ ] **Step 1: Write the failing test**

```typescript
// supabase/functions/shopify-relay/index.test.ts
import { assertEquals } from "std/testing/asserts.ts";
import { stub } from "std/testing/mock.ts";
import * as configModule from "./config.ts";
import * as variantModule from "./variant.ts";
import * as draftOrderModule from "./draftOrder.ts";
import { handleRequest } from "./index.ts";

Deno.test("GET /config returns stored config", async () => {
  const s = stub(configModule, "getShopConfig", () => Promise.resolve({ minimumOrderTotal: 5 }));
  try {
    const res = await handleRequest(new Request("https://relay.test/config", { method: "GET" }));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { config: { minimumOrderTotal: 5 } });
  } finally {
    s.restore();
  }
});

Deno.test("POST /config without correct password returns 401", async () => {
  const res = await handleRequest(new Request("https://relay.test/config", {
    method: "POST",
    headers: { "x-admin-password": "wrong", "content-type": "application/json" },
    body: JSON.stringify({ config: {} }),
  }));
  assertEquals(res.status, 401);
});

Deno.test("POST /checkout below threshold creates a priced variant", async () => {
  const s = stub(variantModule, "createPricedVariant", () => Promise.resolve({ variantId: 999 }));
  try {
    const res = await handleRequest(new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 17.68,
        thresholdExceeded: false,
        lineItems: [{ title: "Model 1", price: "17.68", quantity: 1, properties: [] }],
      }),
    }));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { mode: "cart", variantId: 999 });
  } finally {
    s.restore();
  }
});

Deno.test("POST /checkout above threshold creates a draft order", async () => {
  const s = stub(draftOrderModule, "createDraftOrder", () =>
    Promise.resolve({ invoiceUrl: "https://example.com/invoice" }));
  try {
    const res = await handleRequest(new Request("https://relay.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: "jane@example.com",
        customerName: "Jane Smith",
        grandTotal: 180,
        thresholdExceeded: true,
        lineItems: [{ title: "Model 1", price: "180.00", quantity: 1, properties: [] }],
      }),
    }));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { mode: "draft-order", invoiceUrl: "https://example.com/invoice" });
  } finally {
    s.restore();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-env supabase/functions/shopify-relay/index.test.ts`
Expected: FAIL — `index.ts` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// supabase/functions/shopify-relay/index.ts
import { getShopConfig, saveShopConfig } from "./config.ts";
import { uploadFile } from "./files.ts";
import { createPricedVariant } from "./variant.ts";
import { createDraftOrder, type QuoteLineItem } from "./draftOrder.ts";

const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD")!;

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

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const url = new URL(req.url);

  if (url.pathname.endsWith("/config") && req.method === "GET") {
    const config = await getShopConfig();
    return json({ config });
  }

  if (url.pathname.endsWith("/config") && req.method === "POST") {
    if (req.headers.get("x-admin-password") !== ADMIN_PASSWORD) {
      return json({ error: "Unauthorized" }, 401);
    }
    const { config } = await req.json();
    await saveShopConfig(config);
    return json({ ok: true });
  }

  if (url.pathname.endsWith("/files") && req.method === "POST") {
    const { filename, mimeType, base64Data } = await req.json();
    const file = await uploadFile({ filename, mimeType, base64Data });
    return json(file);
  }

  if (url.pathname.endsWith("/checkout") && req.method === "POST") {
    const body = await req.json() as {
      customerEmail: string;
      customerName: string;
      grandTotal: number;
      thresholdExceeded: boolean;
      lineItems: QuoteLineItem[];
    };

    if (body.thresholdExceeded) {
      const { invoiceUrl } = await createDraftOrder(body);
      return json({ mode: "draft-order", invoiceUrl });
    }

    const totalTitle = body.lineItems.map((li) => li.title).join(", ").slice(0, 250);
    const { variantId } = await createPricedVariant({
      title: totalTitle || "Custom 3D Print",
      price: body.grandTotal.toFixed(2),
    });
    return json({ mode: "cart", variantId });
  }

  return json({ error: "Not found" }, 404);
}

Deno.serve((req) => handleRequest(req));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-env supabase/functions/shopify-relay/index.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Deploy**

```bash
supabase functions deploy shopify-relay --project-ref <project-ref>
```

Verify: `curl https://<project-ref>.supabase.co/functions/v1/shopify-relay/config` returns `{"config":null}` (nothing saved yet).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/shopify-relay/index.ts supabase/functions/shopify-relay/index.test.ts
git commit -m "Add relay HTTP router: config, file upload, and checkout endpoints"
```

---

## Part 2 — Frontend rewiring

### Task 8: `config.js` reads/writes the relay instead of localStorage

**Files:**
- Modify: `js/config.js`

**Interfaces:**
- Consumes: `GET /config`, `POST /config` from Task 7.
- Produces: `getConfig()` now returns a `Promise<Config>` (was synchronous) — every caller in `main.js` and `admin.js` must be updated to `await` it (handled in Tasks 9–10).

- [ ] **Step 1: Add the relay base URL constant and rewrite `getConfig`/`saveConfig`**

```javascript
// js/config.js — add near the top, after CONFIG_KEY
const RELAY_BASE_URL = 'https://<project-ref>.supabase.co/functions/v1/shopify-relay';

// Replace the existing synchronous getConfig() with:
export async function getConfig() {
  try {
    const res = await fetch(`${RELAY_BASE_URL}/config`);
    if (res.ok) {
      const { config: saved } = await res.json();
      if (saved) {
        const merged = {
          ...DEFAULT_CONFIG,
          ...saved,
          materials:     saved.materials?.length     ? saved.materials     : DEFAULT_CONFIG.materials,
          primerOptions: saved.primerOptions?.length  ? saved.primerOptions : DEFAULT_CONFIG.primerOptions,
          sizeTiers:     saved.sizeTiers?.length      ? saved.sizeTiers     : DEFAULT_CONFIG.sizeTiers,
          primerTiers:   saved.primerTiers?.length    ? saved.primerTiers   : DEFAULT_CONFIG.primerTiers,
          plaColors:     saved.plaColors?.length      ? saved.plaColors     : DEFAULT_CONFIG.plaColors,
          extras:        saved.extras?.length         ? saved.extras       : DEFAULT_CONFIG.extras,
        };
        // Cache locally so the calculator still works if the relay is briefly unreachable.
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(merged)); } catch { /* ignore */ }
        return merged;
      }
    }
  } catch { /* fall through to cache below */ }

  // Relay unreachable or nothing saved yet — fall back to last-known-good cache, then defaults.
  try {
    const cached = localStorage.getItem(CONFIG_KEY);
    if (cached) return { ...DEFAULT_CONFIG, ...JSON.parse(cached) };
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

// Replace the existing saveConfig(config) with:
export async function saveConfig(config, adminPassword) {
  const res = await fetch(`${RELAY_BASE_URL}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
    body: JSON.stringify({ config }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error('Incorrect admin password.');
    throw new Error(`Save failed: HTTP ${res.status}`);
  }
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* ignore */ }
  return true;
}
```

Note: `resetConfig()` and `adminPassword` in `DEFAULT_CONFIG` are removed in Task 10 (the relay owns the real password now — see that task).

- [ ] **Step 2: Bump the cache-busting version on every file that imports `config.js`**

`js/config.js` itself doesn't need a self-referential bump, but every importer does. Update:
- `index.html`: `<script type="module" src="js/main.js?v=15">`
- `js/main.js`: `import { getConfig, ... } from './config.js?v=14';` and its own `calculator.js?v=14` import bump
- `js/calculator.js`: `import { getMaterial } from './config.js?v=14';`
- `js/admin.js`: `import { ... } from './config.js?v=7';` and `from './calculator.js?v=7';`
- `admin.html`: bump `css/style.css?v=15` if any admin-side markup changed (it doesn't in this task, skip)

- [ ] **Step 3: Manually verify**

Run: `python server.py 8744`, open `http://localhost:8744`, open DevTools → Network. Confirm a `GET .../config` request fires on load and the page renders with default pricing (since nothing is saved to the relay yet).
Expected: no console errors; Network tab shows the relay call.

- [ ] **Step 4: Commit**

```bash
git add js/config.js index.html js/main.js js/calculator.js js/admin.js
git commit -m "Load and save pricing config via the Shopify relay instead of localStorage"
```

---

### Task 9: `main.js` — await async config, add file upload on parse, real checkout on submit

**Files:**
- Modify: `js/main.js`

**Interfaces:**
- Consumes: relay endpoints via `config.js` (Task 8) plus two new direct calls this task adds: `POST /files` and `POST /checkout` (Task 7).
- Produces: `item.shopifyFileId` and `item.shopifyThumbnailId` set on each ready item — this is the data the future packing tool will read back out of Shopify order line-item properties, so the property names chosen here (`_quote_ref`, `_model_name`, `_files_json`) are the actual contract that tool will parse. Document them exactly as written.

- [ ] **Step 1: Await `getConfig()` at boot**

```javascript
// js/main.js — DOMContentLoaded handler, change:
document.addEventListener('DOMContentLoaded', async () => {
  config = await getConfig();
  applyStaticIcons();
  // ...rest unchanged
});
```

Also update the two other `config = getConfig()` call sites (in the admin-preview `storage` event listener block, if `main.js` still has one — check for `window.addEventListener('storage', ...)` and make it `async` + `await getConfig()` the same way, or remove it since config no longer lives in localStorage as the source of truth and the relay has no cross-tab push mechanism — removing it is simpler and correct here since Task 8's relay-backed config is fetched fresh on every page load already).

- [ ] **Step 2: Upload each STL file's bytes + thumbnail to the relay right after parsing**

In `addFileToGroup` (the function that runs `parseSTLFile` and sets `item.status = 'ready'`), after `item.thumbnail = generateThumbnail(item.data.triangles);` and before `recomputeItemCost(item);`, add:

```javascript
      const RELAY_BASE_URL = 'https://<project-ref>.supabase.co/functions/v1/shopify-relay';

      try {
        const fileBuffer = await file.arrayBuffer();
        const base64Data = btoa(
          new Uint8Array(fileBuffer).reduce((s, b) => s + String.fromCharCode(b), ''),
        );
        const stlUpload = await fetch(`${RELAY_BASE_URL}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: item.name, mimeType: 'model/stl', base64Data }),
        }).then(r => r.json());
        item.shopifyFileId = stlUpload.id;

        if (item.thumbnail) {
          const thumbBase64 = item.thumbnail.split(',')[1]; // strip "data:image/png;base64,"
          const thumbUpload = await fetch(`${RELAY_BASE_URL}/files`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: item.name.replace(/\.stl$/i, '.png'),
              mimeType: 'image/png',
              base64Data: thumbBase64,
            }),
          }).then(r => r.json());
          item.shopifyThumbnailId = thumbUpload.id;
        }
      } catch (err) {
        // Non-fatal: pricing still works without the Shopify-side file copy.
        // The packing tool just won't have a thumbnail for this part if this failed.
        console.warn('Shopify file upload failed for', item.name, err);
      }
```

- [ ] **Step 3: Replace the `submitOrder` stub with a real relay call**

```javascript
// js/main.js — replace the body of submitOrder from the payload block onward:
function submitOrder(e) {
  e.preventDefault();
  const form       = e.target;
  const name       = form.querySelector('[name="cust-name"]').value.trim();
  const email      = form.querySelector('[name="cust-email"]').value.trim();
  const notes      = form.querySelector('[name="cust-notes"]').value.trim();
  const disclaimer = form.querySelector('[name="disclaimer"]').checked;

  if (!name || !email) { showToast('Please fill in your name and email.', 'error'); return; }
  if (!disclaimer)     { showToast('Please tick the confirmation checkbox to continue.', 'error'); return; }

  const activeGroups = groups.filter(g => g.items.some(i => i.status === 'ready'));
  const grandTotal   = calcOrderTotal(activeGroups, config);
  const thresholdExceeded = exceedsCustomQuoteThreshold(grandTotal, config);

  const lineItems = activeGroups.map(g => {
    const files = g.items
      .filter(i => i.status === 'ready' && i.cost?.priceable)
      .map(i => ({
        filename: i.name,
        fileId: i.shopifyFileId ?? null,
        thumbnailId: i.shopifyThumbnailId ?? null,
        quantity: i.settings.quantity,
      }));
    return {
      title: g.name,
      price: (g.groupCost?.groupTotal ?? 0).toFixed(2),
      quantity: 1,
      properties: [
        { name: '_quote_ref', value: _orderNumber ?? '' },
        { name: '_model_name', value: g.name },
        { name: '_print_method', value: g.settings.printMethod },
        { name: '_notes', value: g.settings.notes || '' },
        { name: '_files_json', value: JSON.stringify(files) },
      ],
    };
  });

  const RELAY_BASE_URL = 'https://<project-ref>.supabase.co/functions/v1/shopify-relay';
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

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
    .then(r => {
      if (!r.ok) throw new Error(`Checkout failed: HTTP ${r.status}`);
      return r.json();
    })
    .then(result => {
      if (result.mode === 'draft-order') {
        window.location.href = result.invoiceUrl;
        return;
      }
      // mode === 'cart' — add the priced variant to the real Shopify cart, then go to checkout.
      return fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            id: result.variantId,
            quantity: 1,
            properties: {
              _quote_ref: _orderNumber ?? '',
              _customer_notes: notes,
            },
          }],
        }),
      }).then(r => {
        if (!r.ok) throw new Error(`Add to cart failed: HTTP ${r.status}`);
        window.location.href = '/checkout';
      });
    })
    .catch(err => {
      console.error(err);
      showToast('Something went wrong submitting your order — please try again or contact us.', 'error');
      if (submitBtn) submitBtn.disabled = false;
    });
}
```

Note: the per-model line items each carry their own `_files_json` property (an array of `{filename, fileId, thumbnailId, quantity}`), but only the FIRST line item's variant is actually added to `/cart/add.js` in the `mode: "cart"` path as currently written — because `createPricedVariant` in Task 5 collapses all line items into one variant priced at `grandTotal`. To make sure that first group's data isn't lost entirely, the relay's `/checkout` handler returns `properties` (the first line item's `properties` array flattened into an object) alongside `variantId` in its `mode: "cart"` response, and `main.js` merges those into the `/cart/add.js` call's properties object (alongside the frontend-authoritative `_quote_ref`/`_customer_notes`). **This is a known simplification for v1**: multi-model orders show as a single cart line titled with all model names joined together, and only that first line item's properties reach the order — but for a single-model order (the common case) all of that model's properties now correctly reach the order, where before this fix none of them did. Fix the multi-model gap before relying on the packing tool for multi-model orders — either loop `POST /checkout` per group (N relay calls, N variants, N cart adds, all before one `/checkout` redirect) or extend Task 5/7 to accept multiple line items and return one variant ID per group. Flag this explicitly to the person building this — it's a real gap, not a placeholder omission.

- [ ] **Step 4: Manually verify end-to-end (requires Tasks 1–8 deployed)**

1. Run `python server.py 8744`, upload a small STL, confirm in Network tab that `POST .../files` fires and returns a `gid://shopify/GenericFile/...` id.
2. Fill in the contact form for a single-model order under £150, submit.
3. Confirm: browser redirects to `/checkout` on the real Shopify store, cart contains one line item priced at the exact calculated total.
4. In Shopify Admin → Products, confirm a new variant was added to "Custom 3D Print (do not edit)" with that price.
5. Repeat with a model priced over £150 — confirm it redirects to a Shopify-hosted Draft Order invoice page instead.

- [ ] **Step 5: Commit**

```bash
git add js/main.js
git commit -m "Wire real Shopify checkout: file upload on parse, cart/draft-order on submit"
```

---

### Task 10: `admin.js` — server-side password check, async config

**Files:**
- Modify: `js/admin.js`
- Modify: `js/config.js` (remove `adminPassword` from `DEFAULT_CONFIG` — Task 8 already stopped reading it from the relay's config object; this step removes the last client-side trace of it)

**Interfaces:**
- Consumes: `getConfig()`/`saveConfig(config, password)` (Task 8), `POST /config` 401 response (Task 7) as the auth check itself — there's no separate login endpoint, a failed save IS the auth failure.

- [ ] **Step 1: Remove `adminPassword` from `DEFAULT_CONFIG` in `js/config.js`**

Delete the line `adminPassword:   'admin123',` from `DEFAULT_CONFIG`. The relay's `ADMIN_PASSWORD` secret (Task 1) is now the only copy of the real password anywhere.

- [ ] **Step 2: Rewrite the auth flow in `admin.js` to verify the password via a save-config round trip**

```javascript
// js/admin.js — replace showAuthModal's form submit handler:
document.getElementById('auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = document.getElementById('auth-password').value;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    config = await getConfig();
    await saveConfig(config, pw); // no-op save, just to verify the password server-side
    sessionStorage.setItem('admin_auth', '1');
    sessionStorage.setItem('admin_pw', pw); // needed for subsequent real saves this session
    document.getElementById('auth-overlay').style.display = 'none';
    bootAdmin();
  } catch (err) {
    document.getElementById('auth-error').textContent = err.message || 'Incorrect password.';
  } finally {
    submitBtn.disabled = false;
  }
});
```

Remove the `auth-reset-btn` handler entirely (Task 1's `.env.example` documents that resetting `ADMIN_PASSWORD` is now a `supabase secrets set` operation for whoever administers the Supabase project — not something the page itself can do, since the password no longer lives in anything the browser can touch).

- [ ] **Step 3: Update `bootAdmin()` and the save button to use the async `getConfig`/`saveConfig` and the session-cached password**

```javascript
// js/admin.js — bootAdmin, change the top line:
async function bootAdmin() {
  config = await getConfig();
  // ...rest of bootAdmin unchanged (renderForm(), renderMaterials(), setupEvents(), updatePreview())
}

// js/admin.js — the save-btn click handler, change to:
document.getElementById('save-btn')?.addEventListener('click', async () => {
  collectForm();
  try {
    await saveConfig(config, sessionStorage.getItem('admin_pw'));
    showToast('Settings saved', 'success');
  } catch (err) {
    showToast(err.message || 'Save failed', 'error');
  }
});
```

- [ ] **Step 4: Remove `resetConfig` import and the "Reset to Defaults" button's old localStorage-clearing behavior**

`resetConfig()` in `config.js` cleared `localStorage`; that's no longer the source of truth. Change `reset-btn`'s handler to load `DEFAULT_CONFIG` into the form fields (without saving) so the admin can review defaults, then click Save themselves if they want to commit them:

```javascript
document.getElementById('reset-btn')?.addEventListener('click', () => {
  if (!confirm('Load default settings into the form? Nothing is saved until you click Save Settings.')) return;
  config = { ...DEFAULT_CONFIG };
  renderForm();
  renderMaterials();
  updatePreview();
});
```

- [ ] **Step 5: Manually verify**

1. Open `admin.html`, enter the wrong password → confirm "Incorrect password." shown, no access granted.
2. Enter the correct password (the one set in Task 1 Step 6) → confirm the panel loads.
3. Change a value (e.g. minimum order total), click Save Settings → confirm success toast.
4. Reload the page, log in again → confirm the changed value persisted (proves it round-tripped through the relay, not localStorage).

- [ ] **Step 6: Commit**

```bash
git add js/admin.js js/config.js
git commit -m "Check admin password server-side via the relay instead of client-side JS"
```

---

## Part 3 — Shopify theme embedding

### Task 11: Page template on the Shopify theme

**Files:**
- Create (in the Shopify theme, via Shopify Admin → Online Store → Themes → Edit code — this repo's static assets are uploaded there, not committed to this git repo, since Shopify theme code lives in Shopify's own theme storage): `templates/page.print-calculator.json`
- Create: `sections/print-calculator.liquid`

**Interfaces:**
- Consumes: every file in this repo's `index.html`/`js/`/`css/` as static theme assets.
- Produces: a real page on the storefront, e.g. `https://arcane-flame.com/pages/3d-print-calculator`.

- [ ] **Step 1: Upload the static assets as theme assets**

In the Shopify theme editor's Assets folder, upload (or use Shopify CLI `shopify theme push` from a copy of this repo's `js/`, `css/` directories renamed to avoid clashing with existing theme assets, e.g. prefix each with `print-calc-`):
- `assets/print-calc-main.js`, `assets/print-calc-icons.js`, `assets/print-calc-config.js`, `assets/print-calc-calculator.js`, `assets/print-calc-stl-parser.js`, `assets/print-calc-viewer.js`
- `assets/print-calc-style.css`

Update the `?v=N` import paths inside these uploaded copies to plain relative filenames (Shopify serves assets from a flat `assets/` directory, so `./config.js?v=14` becomes `print-calc-config.js` — no relative subpaths, no query string needed since Shopify's CDN asset URLs are already content-hashed/versioned by Shopify itself).

- [ ] **Step 2: Write the section that embeds the calculator's markup**

```liquid
{% comment %} sections/print-calculator.liquid {% endcomment %}
<div class="print-calculator-embed">
  {% render 'print-calculator-markup' %}
</div>

{{ 'print-calc-style.css' | asset_url | stylesheet_tag }}
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/"
  }
}
</script>
<script type="module" src="{{ 'print-calc-main.js' | asset_url }}"></script>

{% schema %}
{
  "name": "3D Print Calculator",
  "settings": []
}
{% endschema %}
```

- [ ] **Step 3: Write `snippets/print-calculator-markup.liquid` containing this repo's `index.html` body content**

Copy everything between `<body>` and `</body>` in this repo's `index.html` (the `.app-wrap` div through the order overlay) into `snippets/print-calculator-markup.liquid` verbatim — it's plain HTML with `data-icon*` attributes, nothing Liquid-specific needed inside it.

- [ ] **Step 4: Create the page template**

```json
{
  "sections": {
    "main": {
      "type": "print-calculator"
    }
  },
  "order": ["main"]
}
```

Save as `templates/page.print-calculator.json`.

- [ ] **Step 5: Create the storefront page and assign the template**

Shopify Admin → Online Store → Pages → Add page. Title: "3D Print Calculator". In the Theme template dropdown (right sidebar), select `page.print-calculator`. Save.

- [ ] **Step 6: Manually verify on the live storefront**

Visit the new page's URL. Confirm: the calculator loads, drop a test STL, confirm pricing renders, confirm the "Admin" link in the header still points to `admin.html` — **update that link** to wherever `admin.html` is now hosted (it should NOT be a Shopify theme page, since it needs to stay unauthenticated-by-Shopify and gated only by the relay's password check; keep hosting `admin.html` at its current static location, e.g. GitHub Pages or wherever this repo is deployed, and just update the header link's `href` in `snippets/print-calculator-markup.liquid` to the full external URL).

- [ ] **Step 7: Commit the theme-side liquid files to this repo for version history, even though Shopify is their real runtime home**

```bash
mkdir -p shopify-theme/sections shopify-theme/snippets shopify-theme/templates
# copy the four files created above into shopify-theme/... matching paths
git add shopify-theme/
git commit -m "Add Shopify theme embedding files (sections/snippets/templates)"
```

---

## Part 4 — Final verification

### Task 12: End-to-end smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full customer journey, under threshold**

On the live storefront page: upload an STL → configure it → Request a Quote → fill contact form → submit. Confirm: real Shopify cart page loads with the correct line item and price, checkout completes with a test payment (Shopify's Bogus Gateway if in test mode).

- [ ] **Step 2: Full customer journey, over threshold**

Same flow with a model priced over £150. Confirm: redirected to a Draft Order invoice page instead of the cart, order does NOT appear as a paid order until you manually send/approve the invoice from Shopify Admin.

- [ ] **Step 3: Confirm file linkage survives to the order**

After the under-threshold test order completes, open it in Shopify Admin → Orders → the test order → line item → check its properties/attributes. Confirm `_files_json` is present and contains a real `fileId` (a `gid://shopify/GenericFile/...`). Open that file in Shopify Admin → Content → Files and confirm it's the actual uploaded STL.

- [ ] **Step 4: Confirm admin panel changes persist across devices**

Change a price in `admin.html` from one browser, then open `admin.html` in a different browser (or incognito window) and confirm the changed value shows without re-entering it — proves the relay/metafield round trip works, not a per-browser cache.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "Shopify integration verified end-to-end"
```

---

## Explicitly out of scope for this plan

- **The packing/sorting tool itself.** This plan only ensures every order's line items carry `_files_json` (file + thumbnail Shopify GIDs) so that tool can be built later without touching the calculator or relay again. When you're ready to build it: it needs its own relay endpoint (e.g. `GET /orders?since=<date>` proxying `shopifyGraphQL` against `orders` + `lineItems.customAttributes`) since it also can't hold the Admin API secret client-side — likely a small addition to this same Supabase function, not a new system.
- **Cleaning up orphaned Shopify Files** from parts customers add then remove before checkout (noted as a known tradeoff above).
- **Multi-model cart line items** — Task 9 flags this as a real v1 gap: only ONE variant/cart-line is created for the whole order (priced at `grandTotal`), so only the first model group's properties (`_quote_ref`/`_model_name`/`_print_method`/`_notes`/`_files_json`) travel with it — a multi-model order shows as a single cart line titled with all model names joined together, and the packing tool will only see file data for the first model. (The draft-order path does not have this gap: `createDraftOrder` already preserves every line item's own properties via Shopify's `customAttributes`, since each model gets its own draft-order line item there.) Needs a follow-up — either loop `POST /checkout` per group (N relay calls, N variants, N cart adds, all before one `/checkout` redirect) or extend the checkout endpoint to accept multiple line items and return one variant ID per group — before the packing tool can be trusted for multi-model orders on the cart path.
- **Shopify order confirmation emails** — these fire automatically and natively once a real Shopify order exists (nothing to build), but their content/branding is a theme email template concern, not covered here.
