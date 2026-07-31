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

interface UploadFileInput {
  filename: string;
  mimeType: string;
  /** Raw file bytes, base64-encoded (frontend sends this over JSON). */
  base64Data: string;
}

export async function uploadFile(
  input: UploadFileInput,
): Promise<{ id: string; url: string | null }> {
  const bytes = Uint8Array.from(atob(input.base64Data), (c) => c.charCodeAt(0));

  const staged = await shopifyGraphQL<{
    stagedUploadsCreate: {
      stagedTargets: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }>;
    };
  }>(STAGE_MUTATION, {
    input: [{
      filename: input.filename,
      mimeType: input.mimeType,
      httpMethod: "POST",
      resource: input.mimeType.startsWith("image/") ? "IMAGE" : "FILE",
    }],
  });

  const targets = staged.stagedUploadsCreate.stagedTargets;
  if (!targets?.length) {
    throw new Error("Shopify did not return a staged upload target");
  }
  const target = targets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([bytes], { type: input.mimeType }), input.filename);

  const putRes = await fetch(target.url, { method: "POST", body: form });
  if (!putRes.ok) {
    throw new Error(`Staged upload PUT failed: HTTP ${putRes.status}`);
  }

  const created = await shopifyGraphQL<{
    fileCreate: {
      files: Array<{ id: string; preview: { image: { url: string } | null } | null }>;
    };
  }>(FILE_CREATE_MUTATION, {
    files: [{
      alt: input.filename,
      contentType: input.mimeType.startsWith("image/") ? "IMAGE" : "FILE",
      originalSource: target.resourceUrl,
    }],
  });

  const files = created.fileCreate.files;
  if (!files?.length) {
    throw new Error("Shopify did not return a created file");
  }
  const file = files[0];
  return { id: file.id, url: file.preview?.image?.url ?? null };
}
