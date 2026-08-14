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

interface StageUploadInput {
  filename: string;
  mimeType: string;
}

export interface StagedUploadTarget {
  /** The URL the browser should POST the raw file bytes to directly. */
  url: string;
  /** Passed back to finalizeUpload() once the direct upload completes. */
  resourceUrl: string;
  /** Form fields the browser must include (in order) alongside the file in that POST. */
  parameters: Array<{ name: string; value: string }>;
}

/**
 * Requests a Shopify staged-upload target for a file the browser will
 * upload directly (see finalizeUpload's doc comment for why). This call
 * only exchanges small JSON with Shopify — it never sees the file's bytes.
 */
export async function stageUpload(input: StageUploadInput): Promise<StagedUploadTarget> {
  const staged = await shopifyGraphQL<{
    stagedUploadsCreate: { stagedTargets: StagedUploadTarget[] };
  }>(STAGE_MUTATION, {
    input: [{
      filename: input.filename,
      mimeType: input.mimeType,
      httpMethod: "POST",
      resource: input.mimeType.startsWith("image/") ? "IMAGE" : "FILE",
    }],
  });

  const target = staged.stagedUploadsCreate.stagedTargets?.[0];
  if (!target) {
    throw new Error("Shopify did not return a staged upload target");
  }
  return target;
}

interface FinalizeUploadInput {
  /** The resourceUrl returned by stageUpload(), after the browser has POSTed the file there. */
  resourceUrl: string;
  filename: string;
  mimeType: string;
}

/**
 * Registers an already-uploaded file with Shopify Files, returning its GID
 * and (if available yet) a preview URL.
 *
 * Together, stageUpload()+the browser's direct POST+finalizeUpload() replace
 * a single uploadFile() that used to receive the file as base64 JSON and
 * relay it to Shopify itself. Routing large STL files (tens of MB) through
 * this Edge Function that way meant base64-decoding and re-uploading the
 * whole thing inside a resource-constrained function — real customer files
 * routinely exceeded its CPU/memory limits and crashed with a 546
 * WORKER_LIMIT error, silently losing the file. Uploading straight from the
 * browser to the signed URL Shopify provides is the standard pattern for
 * exactly this reason: this function's involvement is now two small GraphQL
 * calls, regardless of file size.
 */
export async function finalizeUpload(
  input: FinalizeUploadInput,
): Promise<{ id: string; url: string | null }> {
  const created = await shopifyGraphQL<{
    fileCreate: {
      files: Array<{ id: string; preview: { image: { url: string } | null } | null }>;
    };
  }>(FILE_CREATE_MUTATION, {
    files: [{
      alt: input.filename,
      contentType: input.mimeType.startsWith("image/") ? "IMAGE" : "FILE",
      originalSource: input.resourceUrl,
    }],
  });

  const files = created.fileCreate.files;
  if (!files?.length) {
    throw new Error("Shopify did not return a created file");
  }
  const file = files[0];
  return { id: file.id, url: file.preview?.image?.url ?? null };
}

const RESOLVE_FILE_QUERY = `
  query ResolveFileUrl($id: ID!) {
    node(id: $id) {
      ... on GenericFile { url }
      ... on MediaImage { image { url } }
    }
  }
`;

// Shopify processes uploaded files asynchronously — a file created moments
// ago may not have a resolved download URL yet. Two short retries (not a
// long poll) cover the common case without meaningfully delaying quote
// creation; if still unresolved, the caller falls back to referencing the
// file by its Shopify GID instead of a clickable link (see index.ts).
const FILE_URL_RETRY_DELAYS_MS = [500, 500];

export async function resolveFileUrl(fileId: string): Promise<string | null> {
  for (let attempt = 0; attempt <= FILE_URL_RETRY_DELAYS_MS.length; attempt++) {
    const data = await shopifyGraphQL<{
      node: { url?: string | null; image?: { url: string } | null } | null;
    }>(RESOLVE_FILE_QUERY, { id: fileId });
    const url = data.node?.url ?? data.node?.image?.url ?? null;
    if (url) return url;
    if (attempt < FILE_URL_RETRY_DELAYS_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, FILE_URL_RETRY_DELAYS_MS[attempt]));
    }
  }
  return null;
}
