// supabase/functions/shopify-relay/measurements.ts
//
// Reads geometry that was measured when the file was uploaded.
//
// Phase 1 of server-side pricing measured every file inside the /checkout
// request. One model was fine; eight killed the edge worker outright — parsing
// an STL loops over every triangle in JS, and the per-request CPU budget ran
// out around the third model, with no response reaching the browser at all.
//
// Measurement therefore happens once, as the file lands (the measure-stl
// function, nudged by a trigger on storage.objects), and checkout does nothing
// but look the numbers up. A lookup is microseconds; the arithmetic that
// follows is trivial. Nothing in the hot path parses geometry any more.

import { createClient } from "jsr:@supabase/supabase-js@2";

export const BUCKET = "quote-uploads";

export interface StoredMeasurement {
  path: string;
  volumeMl: number;
  dimensions: { x: number; y: number; z: number };
  sizeBytes: number | null;
  triangleCount: number | null;
  /** Null when the row exists but no successful measurement has landed yet. */
  measuredAt: string | null;
  /** Set when the file was tried and could not be read. */
  error: string | null;
}

function db() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

/**
 * Fetches whatever measurements exist for these paths, in one round trip.
 *
 * A path missing from the returned map means "not measured" — which the caller
 * must treat as unverifiable rather than as a zero-volume model. Returning an
 * empty map on error is deliberate for the same reason: a database hiccup must
 * degrade to "could not verify", never to a cheaper price.
 */
export async function lookupMeasurements(
  paths: string[],
): Promise<Map<string, StoredMeasurement>> {
  const out = new Map<string, StoredMeasurement>();
  if (paths.length === 0) return out;

  try {
    const { data, error } = await db()
      .from("stl_measurements")
      .select(
        "path, volume_ml, dim_x, dim_y, dim_z, size_bytes, triangle_count, measured_at, error",
      )
      .eq("bucket_id", BUCKET)
      .in("path", paths);

    if (error) {
      console.error("shopify-relay: measurement lookup failed", error.message);
      return out;
    }

    for (const row of data ?? []) {
      // A row with no successful measurement is still worth returning, so the
      // caller can report *why* it could not verify rather than just "missing".
      out.set(row.path, {
        path: row.path,
        volumeMl: Number(row.volume_ml),
        dimensions: {
          x: Number(row.dim_x),
          y: Number(row.dim_y),
          z: Number(row.dim_z),
        },
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
        triangleCount: row.triangle_count === null
          ? null
          : Number(row.triangle_count),
        measuredAt: row.measured_at,
        error: row.error,
      });
    }
  } catch (err) {
    console.error("shopify-relay: measurement lookup threw", err);
  }

  return out;
}

/** Records a measurement taken outside the measure-stl function (the relay's
 *  bounded inline fallback), so the next checkout for the same basket is a
 *  pure lookup. Best-effort by contract: never fail a checkout over this. */
export async function saveMeasurement(
  path: string,
  m: {
    volumeMl: number;
    dimensions: { x: number; y: number; z: number };
    triangleCount: number;
    isAscii: boolean;
    bytesRead: number;
  },
): Promise<void> {
  try {
    await db().from("stl_measurements").upsert({
      bucket_id: BUCKET,
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
    }, { onConflict: "bucket_id,path" });
  } catch (err) {
    console.error("shopify-relay: measurement save threw", err);
  }
}
