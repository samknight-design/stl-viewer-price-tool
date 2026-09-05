// supabase/functions/shopify-relay/files.test.ts
import { assertEquals, assertRejects } from "std/testing/asserts.ts";
import { buildObjectPath, safeFilename, safeSegment, stageUpload } from "./files.ts";

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
    const result = await stageUpload({
      filename: "part.stl",
      mimeType: "model/stl",
      fileSize: 1024,
      quoteRef: "AF-20260905-FDB2",
      modelName: "Model 2",
    });
    // The object path is generated inside stageUpload itself from the quote
    // ref and model name, so it is fully predictable — that predictability
    // is the whole point: an order's files have to be findable in storage
    // from the order alone.
    assertEquals(result.path, "AF-20260905-FDB2/Model-2/part.stl");
    assertEquals(
      result.uploadUrl,
      "https://project-ref.supabase.co/storage/v1/object/upload/sign/quote-uploads/AF-20260905-FDB2/Model-2/part.stl?token=fake-upload-token",
    );
    assertEquals(
      result.publicUrl,
      "https://project-ref.supabase.co/storage/v1/object/public/quote-uploads/AF-20260905-FDB2/Model-2/part.stl",
    );
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
      () =>
        stageUpload({
          filename: "part.stl",
          mimeType: "model/stl",
          fileSize: 1024,
          quoteRef: "AF-1",
          modelName: "Model 1",
        }),
      Error,
      "Failed to create signed upload URL",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Object path construction -------------------------------------------
// These are the reason the whole change exists: before it, every upload got
// a fresh UUID folder and there was no way back from an order to its files.

Deno.test("buildObjectPath files an upload under its quote ref and model", () => {
  assertEquals(
    buildObjectPath({
      filename: "neck 4.stl",
      mimeType: "model/stl",
      fileSize: 1,
      quoteRef: "AF-20260905-FDB2",
      modelName: "Model 7",
    }),
    "AF-20260905-FDB2/Model-7/neck 4.stl",
  );
});

Deno.test("buildObjectPath falls back to a dated unlinked folder when the quote ref is missing", () => {
  // An older cached copy of the frontend won't send a quote ref. Losing the
  // upload would be worse than filing it awkwardly, so it still lands
  // somewhere a human can find by date.
  const path = buildObjectPath({ filename: "part.stl", mimeType: "model/stl", fileSize: 1 });
  const day = new Date().toISOString().slice(0, 10);
  assertEquals(path.startsWith(`unlinked/${day}/`), true);
  assertEquals(path.endsWith("/part.stl"), true);
});

Deno.test("buildObjectPath cannot be made to climb out of its folder", () => {
  assertEquals(
    buildObjectPath({
      filename: "../../etc/passwd",
      mimeType: "model/stl",
      fileSize: 1,
      quoteRef: "../../..",
      modelName: "../secrets",
    }),
    "unknown-quote/secrets/passwd",
  );
});

Deno.test("safeSegment and safeFilename bound and clean their input", () => {
  assertEquals(safeSegment("", "fallback"), "fallback");
  assertEquals(safeSegment("Model  //  3", "fallback"), "Model-3");
  assertEquals(safeSegment("x".repeat(200), "fallback").length, 60);
  assertEquals(safeFilename("C:\\Users\\sam\\part.stl"), "part.stl");
  assertEquals(safeFilename(""), "file");
});
