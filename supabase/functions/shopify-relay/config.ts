import { shopifyGraphQL } from "./shopify.ts";

const NAMESPACE = "print_calculator";
const KEY = "pricing_config";

const GET_QUERY = `
  query GetPricingConfig {
    shop {
      metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
        value
      }
    }
  }
`;

export async function getShopConfig(): Promise<Record<string, unknown> | null> {
  const data = await shopifyGraphQL<{ shop: { metafield: { value: string } | null } }>(
    GET_QUERY,
  );
  if (!data.shop.metafield) return null;
  return JSON.parse(data.shop.metafield.value);
}

const SET_MUTATION = `
  mutation SavePricingConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

export async function saveShopConfig(config: Record<string, unknown>): Promise<void> {
  const shopGid = await getShopGid();
  await shopifyGraphQL(SET_MUTATION, {
    metafields: [
      {
        ownerId: shopGid,
        namespace: NAMESPACE,
        key: KEY,
        type: "json",
        value: JSON.stringify(config),
      },
    ],
  });
}

async function getShopGid(): Promise<string> {
  const data = await shopifyGraphQL<{ shop: { id: string } }>(`query { shop { id } }`);
  return data.shop.id;
}
