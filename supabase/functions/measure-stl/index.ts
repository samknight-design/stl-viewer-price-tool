// supabase/functions/measure-stl/index.ts
//
// Measures one uploaded STL and caches its geometry, so /checkout never has to.
//
// Nudged by the stl_measure_on_upload trigger on storage.objects as a file
// lands. One file per invocation is the whole point: parsing an STL loops over
// every triangle in JS, and doing several in one request is what killed the
// relay's checkout path (see measurements.ts). One ~24 MB model costs well
// under a second of CPU, comfortably inside the budget.
//
// AUTHENTICATION — read this before changing it.
//
// This endpoint is unauthenticated, like the relay's /files/stage. That is a
// deliberate, bounded decision, not an oversight:
//
//   * The only input is a storage path. Everything written is derived from the
//     bytes actually at that path, so a caller cannot forge a measurement —
//     the worst they can do is ask us to measure a real file correctly.
//   * It refuses anything outside quote-uploads, anything not ending .stl, and
//     anything over MAX_BYTES.
//   * It no-ops when a fresh measurement already exists, and gives up after
//     MAX_ATTEMPTS, so repeat calls are cheap and cannot loop.
//
// The residual risk is a caller burning function invocations. To close it,
// set MEASURE_SHARED_SECRET on this function and have the trigger send a
// matching x-measure-secret header (store it in Vault and read it in
// nudge_stl_measurement). The check below activates automatically as soon as
// that env var exists, so adding the secret is the only step needed.

import { measureStlStream, StlTooLargeError } from "../shopify-relay/stl.ts";
import { downloadObject } from "../shopify-relay/files.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "quote-uploads";
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-measure-secret",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

function db() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

/** Rejects anything that is not a plain object key inside this bucket. */
export function isAcceptablePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) {
    return false;
  }
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    return false;
  }
  return /\.stl$/i.test(path);
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);

  // Only enforced once the secret exists — see the note at the top.
  const expected = Deno.env.get("MEASURE_SHARED_SECRET");
  if (expected && req.headers.get("x-measure-secret") !== expected) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: { bucket?: string; path?: string; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Malformed JSON body" }, 400);
  }

  const bucket = body.bucket ?? BUCKET;
  if (bucket !== BUCKET) return json({ error: "Unsupported bucket" }, 400);
  if (!isAcceptablePath(body.path)) return json({ error: "Unsupported path" }, 400);
  const path = body.path;

  const supabase = db();

  // Skip work we have already done. The trigger resets measured_at on re-upload
  // (the storage path is deterministic, so a customer re-adding a part
  // overwrites it), which is what makes this safe rather than stale.
  const { data: existing } = await supabase
    .from("stl_measurements")
    .select("measured_at, attempts")
    .eq("bucket_id", bucket)
    .eq("path", path)
    .maybeSingle();

  if (!body.force && existing?.measured_at) {
    return json({ ok: true, skipped: "already measured", path });
  }
  if (!body.force && (existing?.attempts ?? 0) >= MAX_ATTEMPTS) {
    return json({ ok: true, skipped: "attempt limit reached", path });
  }

  const attempts = (existing?.attempts ?? 0) + 1;

  try {
    const { stream, size } = await downloadObject(path);
    if (size !== null && size > MAX_BYTES) {
      try {
        await stream.cancel();
      } catch { /* already closed */ }
      throw new StlTooLargeError(`file is ${size} bytes, over the ${MAX_BYTES} ceiling`);
    }

    const started = Date.now();
    const m = await measureStlStream(stream, MAX_BYTES);
    const ms = Date.now() - started;

    await supabase.from("stl_measurements").upsert({
      bucket_id: bucket,
      path,
      volume_ml: m.volumeMl,
      dim_x: m.dimensions.x,
      dim_y: m.dimensions.y,
      dim_z: m.dimensions.z,
      triangle_count: m.triangleCount,
      is_ascii: m.isAscii,
      size_bytes: m.bytesRead,
      measured_at: new Date().toISOString(),
      error: null,
      attempts,
    }, { onConflict: "bucket_id,path" });

    console.log(
      `measure-stl ok path="${path}" bytes=${m.bytesRead} tris=${m.triangleCount} ` +
        `ml=${m.volumeMl.toFixed(4)} ms=${ms}`,
    );
    return json({
      ok: true,
      path,
      volumeMl: m.volumeMl,
      dimensions: m.dimensions,
      triangleCount: m.triangleCount,
      ms,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Record the failure so the relay can say why it could not verify, and so
    // attempts are bounded. A file we cannot read must never silently become a
    // cheap price — the relay treats a missing measurement as unverifiable.
    await supabase.from("stl_measurements").upsert({
      bucket_id: bucket,
      path,
      measured_at: null,
      error: message.slice(0, 500),
      attempts,
    }, { onConflict: "bucket_id,path" });

    console.error(`measure-stl failed path="${path}" attempt=${attempts}: ${message}`);
    return json({ ok: false, path, error: message }, 200);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
