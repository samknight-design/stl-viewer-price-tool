// supabase/functions/shopify-relay/files.test.ts
import { assertEquals, assertRejects } from "std/testing/asserts.ts";
import { uploadFile, resolveFileUrl } from "./files.ts";
import { __resetTokenCacheForTests } from "./shopify.ts";

const STAGED_PUT_URL = "https://shopify-staged-uploads.example/put-here";

function tokenResponse() {
  return Promise.resolve(
    new Response(
      JSON.stringify({ access_token: "shpat_fake", expires_in: 86400 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

Deno.test("uploadFile stages, PUTs bytes, then calls fileCreate", async () => {
  __resetTokenCacheForTests();
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    if (url === STAGED_PUT_URL) {
      calls.push("put:" + url);
      return Promise.resolve(new Response("", { status: 201 }));
    }

    // Otherwise, this is a call to the Shopify Admin GraphQL endpoint.
    const body = JSON.parse((init?.body as string) ?? "{}");
    const query: string = body.query ?? "";

    if (query.includes("stagedUploadsCreate")) {
      calls.push("stage");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              stagedUploadsCreate: {
                stagedTargets: [{
                  url: STAGED_PUT_URL,
                  resourceUrl: "https://shopify-staged-uploads.example/resource",
                  parameters: [{ name: "key", value: "tmp/abc" }],
                }],
                userErrors: [],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }

    if (query.includes("fileCreate")) {
      calls.push("create");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              fileCreate: {
                files: [{
                  id: "gid://shopify/GenericFile/999",
                  preview: { image: { url: "https://cdn.example/f.png" } },
                }],
                userErrors: [],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }

    throw new Error("unexpected query: " + query);
  }) as typeof fetch;

  try {
    const result = await uploadFile({
      filename: "part.stl",
      mimeType: "model/stl",
      base64Data: btoa("fake stl bytes"),
    });

    assertEquals(result.id, "gid://shopify/GenericFile/999");
    assertEquals(result.url, "https://cdn.example/f.png");
    assertEquals(calls[0], "stage");
    assertEquals(calls[1].startsWith("put:"), true);
    assertEquals(calls[2], "create");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("uploadFile resolves resource type IMAGE for image mime types in stage request", async () => {
  __resetTokenCacheForTests();
  const resources: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    if (url === STAGED_PUT_URL) {
      return Promise.resolve(new Response("", { status: 201 }));
    }

    const body = JSON.parse((init?.body as string) ?? "{}");
    const query: string = body.query ?? "";

    if (query.includes("stagedUploadsCreate")) {
      const inputArg = body.variables.input[0];
      resources.push(inputArg.resource);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              stagedUploadsCreate: {
                stagedTargets: [{
                  url: STAGED_PUT_URL,
                  resourceUrl: "https://shopify-staged-uploads.example/resource",
                  parameters: [],
                }],
                userErrors: [],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }

    if (query.includes("fileCreate")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              fileCreate: {
                files: [{
                  id: "gid://shopify/MediaImage/111",
                  preview: { image: { url: "https://cdn.example/thumb.png" } },
                }],
                userErrors: [],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }

    throw new Error("unexpected query: " + query);
  }) as typeof fetch;

  try {
    const result = await uploadFile({
      filename: "thumb.png",
      mimeType: "image/png",
      base64Data: btoa("fake png bytes"),
    });

    assertEquals(resources[0], "IMAGE");
    assertEquals(result.id, "gid://shopify/MediaImage/111");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("uploadFile throws when staged upload PUT fails", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    if (url === STAGED_PUT_URL) {
      return Promise.resolve(new Response("nope", { status: 500 }));
    }

    const body = JSON.parse((init?.body as string) ?? "{}");
    const query: string = body.query ?? "";

    if (query.includes("stagedUploadsCreate")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              stagedUploadsCreate: {
                stagedTargets: [{
                  url: STAGED_PUT_URL,
                  resourceUrl: "https://shopify-staged-uploads.example/resource",
                  parameters: [],
                }],
                userErrors: [],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }

    throw new Error("unexpected query: " + query);
  }) as typeof fetch;

  try {
    let threw = false;
    try {
      await uploadFile({
        filename: "part.stl",
        mimeType: "model/stl",
        base64Data: btoa("fake stl bytes"),
      });
    } catch (_e) {
      threw = true;
    }
    assertEquals(threw, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("uploadFile throws a clear error when stagedUploadsCreate returns no targets", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    const query: string = body.query ?? "";

    if (query.includes("stagedUploadsCreate")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              stagedUploadsCreate: { stagedTargets: [], userErrors: [] },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }

    throw new Error("unexpected query: " + query);
  }) as typeof fetch;

  try {
    await assertRejects(
      () =>
        uploadFile({
          filename: "part.stl",
          mimeType: "model/stl",
          base64Data: btoa("fake stl bytes"),
        }),
      Error,
      "Shopify did not return a staged upload target",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("uploadFile throws a clear error when fileCreate returns no files", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    if (url === STAGED_PUT_URL) {
      return Promise.resolve(new Response("", { status: 201 }));
    }

    const body = JSON.parse((init?.body as string) ?? "{}");
    const query: string = body.query ?? "";

    if (query.includes("stagedUploadsCreate")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              stagedUploadsCreate: {
                stagedTargets: [{
                  url: STAGED_PUT_URL,
                  resourceUrl: "https://shopify-staged-uploads.example/resource",
                  parameters: [{ name: "key", value: "tmp/abc" }],
                }],
                userErrors: [],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }

    if (query.includes("fileCreate")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              fileCreate: { files: [], userErrors: [] },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }

    throw new Error("unexpected query: " + query);
  }) as typeof fetch;

  try {
    await assertRejects(
      () =>
        uploadFile({
          filename: "part.stl",
          mimeType: "model/stl",
          base64Data: btoa("fake stl bytes"),
        }),
      Error,
      "Shopify did not return a created file",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
