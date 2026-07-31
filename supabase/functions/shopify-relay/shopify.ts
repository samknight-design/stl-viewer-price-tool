const STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN")!;
const ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_API_TOKEN")!;
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-01";

export async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(
    `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!res.ok) {
    throw new Error(`Shopify Admin API HTTP ${res.status}: ${await res.text()}`);
  }

  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(body.errors.map((e: { message: string }) => e.message).join("; "));
  }
  if (body.data && Object.values(body.data).some(
    (v: any) => v?.userErrors?.length,
  )) {
    const userErrors = Object.values(body.data)
      .flatMap((v: any) => v?.userErrors ?? [])
      .map((e: { field: string[]; message: string }) => `${e.field?.join(".")}: ${e.message}`);
    if (userErrors.length) throw new Error(`Shopify mutation error: ${userErrors.join("; ")}`);
  }

  return body.data as T;
}
