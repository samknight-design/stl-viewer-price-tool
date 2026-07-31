import { shopifyGraphQL } from "./shopify.ts";

const PRODUCT_ID = Deno.env.get("PRINT_PRODUCT_ID")!;

const CREATE_VARIANT_MUTATION = `
  mutation CreatePricedVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

interface CreatePricedVariantInput {
  /** Shown on the order line — put the model/quote name here. */
  title: string;
  /** Decimal string, e.g. "17.68" — must match calcOrderTotal's currency precision. */
  price: string;
}

export async function createPricedVariant(
  input: CreatePricedVariantInput,
): Promise<{ variantId: number }> {
  const data = await shopifyGraphQL<{
    productVariantsBulkCreate: { productVariants: Array<{ id: string }> };
  }>(CREATE_VARIANT_MUTATION, {
    productId: `gid://shopify/Product/${PRODUCT_ID}`,
    variants: [{
      price: input.price,
      optionValues: [{ optionName: "Title", name: input.title }],
      inventoryPolicy: "CONTINUE",
    }],
  });

  const gid = data.productVariantsBulkCreate.productVariants[0].id;
  const variantId = Number(gid.split("/").pop());
  return { variantId };
}
