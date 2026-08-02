const STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN")!;
const CLIENT_ID = Deno.env.get("SHOPIFY_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET")!;
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-01";

// Client-credentials grant tokens expire after 24h; cache and refresh
// with a safety buffer so an in-flight request never gets a stale token.
const TOKEN_REFRESH_BUFFER_MS = 60_000;
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    return cachedToken.value;
  }

  const res = await fetch(`https://${STORE_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    throw new Error(`Shopify OAuth token exchange HTTP ${res.status}: ${await res.text()}`);
  }

  const body = await res.json();
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return cachedToken.value;
}

export function __resetTokenCacheForTests(): void {
  cachedToken = null;
}

export async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const accessToken = await getAccessToken();

  const res = await fetch(
    `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
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
