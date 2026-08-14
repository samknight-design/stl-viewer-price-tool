// supabase/functions/shopify-relay/files.test.ts
import { assertEquals, assertRejects } from "std/testing/asserts.ts";
import { stageUpload } from "./files.ts";

// stageUpload wraps the Supabase Storage JS SDK (createSignedUploadUrl +
// getPublicUrl) rather than a hand-rolled fetch call, so these tests stub
// the SDK's own HTTP call (object/upload/sign) at the fetch layer instead
// of re-implementing GraphQL-style mocking used elsewhere in this file set.
function stubEnv() {
  Deno.env.set("SUPABASE_URL", "https://project-ref.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-fake");
}

Deno.test("stageUpload returns an uploadUrl and publicUrl from a successful sign response", async () => {
  stubEnv();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/object/upload/sign/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            url: "/object/upload/sign/quote-uploads/abc123/part.stl?token=fake-upload-token",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    throw new Error("unexpected fetch: " + url);
  }) as typeof fetch;

  try {
    const result = await stageUpload({ filename: "part.stl", mimeType: "model/stl", fileSize: 1024 });
    // The object path is generated inside stageUpload itself (a fresh random
    // UUID prefix per upload, to avoid collisions) rather than parsed back
    // out of the mocked response, so only the filename suffix is predictable
    // in both URLs.
    assertEquals(result.uploadUrl.startsWith("https://project-ref.supabase.co/storage/v1/object/upload/sign/quote-uploads/"), true);
    assertEquals(result.uploadUrl.endsWith("/part.stl?token=fake-upload-token"), true);
    assertEquals(result.publicUrl.startsWith("https://project-ref.supabase.co/storage/v1/object/public/quote-uploads/"), true);
    assertEquals(result.publicUrl.endsWith("/part.stl"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("stageUpload throws a clear error when Supabase Storage returns an error", async () => {
  stubEnv();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/object/upload/sign/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ message: "Bucket not found", statusCode: "404" }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      );
    }
    throw new Error("unexpected fetch: " + url);
  }) as typeof fetch;

  try {
    await assertRejects(
      () => stageUpload({ filename: "part.stl", mimeType: "model/stl", fileSize: 1024 }),
      Error,
      "Failed to create signed upload URL",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
