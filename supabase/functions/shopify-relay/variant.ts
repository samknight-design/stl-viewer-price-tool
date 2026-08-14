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

// NOTE: every checkout below the custom-quote threshold permanently adds a new
// variant to PRINT_PRODUCT_ID — there is no cleanup or reuse of old variants.
// Shopify caps variants per product at 100 by default, so this product will
// eventually hit that ceiling under sustained order volume and start failing
// checkouts. `title` becomes an option value on the product, so the caller
// (index.ts) is responsible for making it unique per order — see the
// uniqueSuffix logic there. Needs an operational plan (periodic variant
// pruning, or a different pricing mechanism entirely) before this can handle
// meaningful order volume — out of scope for v1.
export async function createPricedVariant(
  input: CreatePricedVariantInput,
): Promise<{ variantId: number }> {
  const data = await shopifyGraphQL<{
    productVariantsBulkCreate: {
      productVariants: Array<{ id: string }>;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(CREATE_VARIANT_MUTATION, {
    productId: `gid://shopify/Product/${PRODUCT_ID}`,
    variants: [{
      price: input.price,
      optionValues: [{ optionName: "Title", name: input.title }],
      inventoryPolicy: "CONTINUE",
    }],
  });

  if (!data.productVariantsBulkCreate.productVariants?.length) {
    const userErrors = data.productVariantsBulkCreate.userErrors ?? [];
    const detail = userErrors.map((e) => e.message).join("; ") || "no productVariants returned";
    throw new Error(`Shopify did not create a variant: ${detail}`);
  }

  const gid = data.productVariantsBulkCreate.productVariants[0].id;
  const variantId = Number(gid.split("/").pop());
  return { variantId };
}
