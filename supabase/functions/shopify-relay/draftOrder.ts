import { shopifyGraphQL } from "./shopify.ts";

export interface QuoteLineItem {
  title: string;
  /** Decimal string, e.g. "180.00" */
  price: string;
  quantity: number;
  properties: Array<{ name: string; value: string }>;
}

const CREATE_DRAFT_ORDER_MUTATION = `
  mutation CreateDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { invoiceUrl }
      userErrors { field message }
    }
  }
`;

export async function createDraftOrder(input: {
  customerEmail: string;
  customerName: string;
  lineItems: QuoteLineItem[];
}): Promise<{ invoiceUrl: string }> {
  const data = await shopifyGraphQL<{
    draftOrderCreate: { draftOrder: { invoiceUrl: string } };
  }>(CREATE_DRAFT_ORDER_MUTATION, {
    input: {
      email: input.customerEmail,
      note2: `Custom quote for ${input.customerName} — over the auto-checkout threshold, review before sending invoice.`,
      lineItems: input.lineItems.map((li) => ({
        title: li.title,
        originalUnitPrice: li.price,
        quantity: li.quantity,
        requiresShipping: true,
        taxable: true,
        customAttributes: li.properties,
      })),
    },
  });

  if (!data.draftOrderCreate.draftOrder) {
    throw new Error("Shopify did not return a created draft order");
  }

  return { invoiceUrl: data.draftOrderCreate.draftOrder.invoiceUrl };
}
