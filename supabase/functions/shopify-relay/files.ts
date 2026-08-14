// supabase/functions/shopify-relay/files.ts
import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "quote-uploads";

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-provided to every Edge
// Function by the platform — no need to set them as our own secrets. The
// service role key bypasses storage RLS, which is what lets this function
// mint signed upload URLs for a bucket the browser has no write access to.
function storageClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

interface StageUploadInput {
  filename: string;
  mimeType: string;
  fileSize: number;
}

export interface StagedUploadTarget {
  /** The URL the browser should PUT the raw file bytes to directly. */
  uploadUrl: string;
  /** Public, permanent URL for the file once uploaded — safe to put straight
   *  in the draft order note; no separate "finalize" step needed. */
  publicUrl: string;
}

/**
 * Quote STL/thumbnail uploads previously went to Shopify Files, but
 * Shopify's Admin API hard-caps generic FILE-resource uploads at 20MB
 * (confirmed via GCS's returned upload policy: content-length-range tops
 * out at 20971520 bytes, regardless of the fileSize passed to
 * stagedUploadsCreate — that field is only honored for VIDEO/MODEL_3D, and
 * MODEL_3D doesn't accept model/stl as a mime type). Real customer STL
 * files routinely exceed 20MB, so that path can never work for them.
 * Supabase Storage's own signed-upload-URL pattern is the same
 * direct-from-browser architecture, just pointed at a bucket we control —
 * its limit is whatever the bucket's file_size_limit is (50MB on this
 * project's free plan; raised on Pro).
 */
export async function stageUpload(input: StageUploadInput): Promise<StagedUploadTarget> {
  const path = `${crypto.randomUUID()}/${input.filename}`;
  const supabase = storageClient();

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    throw new Error(`Failed to create signed upload URL: ${error?.message}`);
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const uploadUrl =
    `${supabaseUrl}/storage/v1/object/upload/sign/${BUCKET}/${encodeURI(data.path)}?token=${data.token}`;

  return { uploadUrl, publicUrl: pub.publicUrl };
}
