// supabase/functions/shopify-relay/files.test.ts
import { assertEquals, assertRejects } from "std/testing/asserts.ts";
import { finalizeUpload, resolveFileUrl, stageUpload } from "./files.ts";
import { __resetTokenCacheForTests } from "./shopify.ts";

function tokenResponse() {
  return Promise.resolve(
    new Response(
      JSON.stringify({ access_token: "shpat_fake", expires_in: 86400 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

Deno.test("stageUpload returns the staged target from stagedUploadsCreate", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let capturedInput: Record<string, unknown> | undefined;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("stagedUploadsCreate")) {
      capturedInput = body.variables.input[0];
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              stagedUploadsCreate: {
                stagedTargets: [{
                  url: "https://shopify-staged-uploads.example/put-here",
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
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    const result = await stageUpload({ filename: "part.stl", mimeType: "model/stl" });
    assertEquals(result.url, "https://shopify-staged-uploads.example/put-here");
    assertEquals(result.resourceUrl, "https://shopify-staged-uploads.example/resource");
    assertEquals(result.parameters, [{ name: "key", value: "tmp/abc" }]);
    assertEquals(capturedInput?.resource, "FILE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("stageUpload resolves resource type IMAGE for image mime types", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  const resources: string[] = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("stagedUploadsCreate")) {
      resources.push(body.variables.input[0].resource);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              stagedUploadsCreate: {
                stagedTargets: [{
                  url: "https://shopify-staged-uploads.example/put-here",
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
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    await stageUpload({ filename: "thumb.png", mimeType: "image/png" });
    assertEquals(resources[0], "IMAGE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("stageUpload throws a clear error when stagedUploadsCreate returns no targets", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("stagedUploadsCreate")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: { stagedUploadsCreate: { stagedTargets: [], userErrors: [] } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    await assertRejects(
      () => stageUpload({ filename: "part.stl", mimeType: "model/stl" }),
      Error,
      "Shopify did not return a staged upload target",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("finalizeUpload calls fileCreate with the given resourceUrl and returns id/url", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;
  let capturedFiles: Array<Record<string, unknown>> | undefined;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("fileCreate")) {
      capturedFiles = body.variables.files;
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
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    const result = await finalizeUpload({
      resourceUrl: "https://shopify-staged-uploads.example/resource",
      filename: "part.stl",
      mimeType: "model/stl",
    });
    assertEquals(result.id, "gid://shopify/GenericFile/999");
    assertEquals(result.url, "https://cdn.example/f.png");
    assertEquals(capturedFiles?.[0].originalSource, "https://shopify-staged-uploads.example/resource");
    assertEquals(capturedFiles?.[0].contentType, "FILE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("finalizeUpload throws a clear error when fileCreate returns no files", async () => {
  __resetTokenCacheForTests();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/oauth/access_token")) return tokenResponse();

    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.query.includes("fileCreate")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: { fileCreate: { files: [], userErrors: [] } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    throw new Error("unexpected query: " + body.query);
  }) as typeof fetch;

  try {
    await assertRejects(
      () =>
        finalizeUpload({
          resourceUrl: "https://shopify-staged-uploads.example/resource",
          filename: "part.stl",
          mimeType: "model/stl",
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
