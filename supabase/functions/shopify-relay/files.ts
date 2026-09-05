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
  /** The quote reference this file belongs to (e.g. "AF-20260905-FDB2").
   *  Becomes the top-level storage folder, which is the only thing tying a
   *  stored file back to its order. */
  quoteRef?: string;
  /** The model group the file was added to (e.g. "Model 2"). Becomes the
   *  sub-folder, so a multi-part order stays legible in the storage browser. */
  modelName?: string;
}

export interface StagedUploadTarget {
  /** The URL the browser should PUT the raw file bytes to directly. */
  uploadUrl: string;
  /** Public, permanent URL for the file once uploaded — safe to put straight
   *  in the draft order note; no separate "finalize" step needed. */
  publicUrl: string;
  /** The object's path within the bucket, relative to the bucket root. This
   *  is what travels in the order's `_models_json`: it is short (no repeated
   *  71-character origin per file) and it survives the bucket ever moving
   *  domains. */
  path: string;
}

/** Storage object keys have to survive being pasted into a URL and read by a
 *  human in the storage browser, so each path segment is reduced to a safe,
 *  bounded ASCII-ish slug. Anything that could climb out of the folder
 *  (`/`, `..`) or break a URL is replaced rather than escaped. */
export function safeSegment(raw: string, fallback: string): string {
  const cleaned = (raw ?? "")
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "-")   // keep letters, digits, _ . - and spaces
    .replace(/\.{2,}/g, ".")        // no ".." path climbing
    .replace(/[\s-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
}

/** Filenames keep their extension and are left as close to the customer's
 *  original as is safe — the shop owner matches them against what the
 *  customer talks about in emails. */
export function safeFilename(raw: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/[^\w.\-() ]+/g, "-")
    .trim()
    .slice(0, 120);
  return cleaned || "file";
}

/**
 * Builds the object key a staged upload writes to.
 *
 * Every file used to land in its own freshly-minted UUID folder, which meant
 * storage held nothing but opaque directories: given an order there was no
 * way to find its files, and given a file no way to tell whose it was. The
 * path is now `<quote-ref>/<model>/<filename>`, so one order is one folder
 * and the order's `_quote_ref` property is the key to it.
 *
 * A file staged without a quote ref (an older cached copy of the frontend,
 * say) still has to go somewhere findable, so it lands under `unlinked/`
 * with a date prefix rather than being rejected — losing the upload would be
 * worse than filing it awkwardly.
 */
export function buildObjectPath(input: StageUploadInput): string {
  const filename = safeFilename(input.filename);
  if (!input.quoteRef) {
    const day = new Date().toISOString().slice(0, 10);
    return `unlinked/${day}/${crypto.randomUUID()}/${filename}`;
  }
  const quoteFolder = safeSegment(input.quoteRef, "unknown-quote");
  const modelFolder = safeSegment(input.modelName ?? "", "model");
  return `${quoteFolder}/${modelFolder}/${filename}`;
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
  const path = buildObjectPath(input);
  const supabase = storageClient();

  // upsert, because the path is now deterministic rather than a fresh UUID:
  // re-adding the same file to the same model (a customer removing a part
  // and putting it back) must overwrite quietly, not fail the upload.
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(path, { upsert: true });
  if (error || !data) {
    throw new Error(`Failed to create signed upload URL: ${error?.message}`);
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const uploadUrl =
    `${supabaseUrl}/storage/v1/object/upload/sign/${BUCKET}/${encodeURI(data.path)}?token=${data.token}`;

  return { uploadUrl, publicUrl: pub.publicUrl, path };
}

/**
 * Writes a machine-readable record of the whole order alongside its files.
 *
 * The cart carries only one line item's worth of properties comfortably, and
 * Shopify imposes its own limits on how much can ride there, so the full
 * order record is written into the quote's own storage folder instead. It
 * sits next to the STLs it describes, which is where anyone digging a file
 * out by hand is already looking.
 *
 * Best-effort by contract: the caller must not fail a checkout because this
 * failed. Returns the manifest's public URL, or null if it could not be
 * written.
 */
export async function writeManifest(
  quoteRef: string,
  manifest: unknown,
): Promise<string | null> {
  try {
    const folder = safeSegment(quoteRef, "unknown-quote");
    const path = `${folder}/manifest.json`;
    const supabase = storageClient();
    const { error } = await supabase.storage.from(BUCKET).upload(
      path,
      new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
      { upsert: true, contentType: "application/json" },
    );
    if (error) {
      console.error("shopify-relay: manifest write failed", error.message);
      return null;
    }
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return pub.publicUrl;
  } catch (err) {
    console.error("shopify-relay: manifest write threw", err);
    return null;
  }
}
