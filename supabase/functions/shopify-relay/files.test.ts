// supabase/functions/shopify-relay/files.test.ts
import { assertEquals, assertRejects } from "std/testing/asserts.ts";
import { uploadFile } from "./files.ts";

const STAGED_PUT_URL = "https://shopify-staged-uploads.example/put-here";

Deno.test("uploadFile stages, PUTs bytes, then calls fileCreate", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

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
  const resources: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

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
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

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
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
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
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

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
