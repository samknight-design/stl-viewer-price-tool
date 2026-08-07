import { shopifyGraphQL } from "./shopify.ts";

export interface QuoteLineItem {
  title: string;
  /** Decimal string, e.g. "180.00" */
  price: string;
  quantity: number;
  properties: Array<{ name: string; value: string }>;
}

export interface CreateDraftOrderInput {
  customerId: string;
  note: string;
  tags: string[];
  lineItems: QuoteLineItem[];
}

const CREATE_DRAFT_ORDER_MUTATION = `
  mutation CreateDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }
`;

/**
 * Creates an unsent draft order linked to a real Shopify customer. This
 * never sends an invoice to the customer (no draftOrderInvoiceSend call
 * anywhere in this codebase) — it's meant to sit in Shopify Admin for
 * manual review/editing before the shop owner sends it themselves.
 */
export async function createDraftOrder(
  input: CreateDraftOrderInput,
): Promise<{ draftOrderId: string }> {
  const data = await shopifyGraphQL<{
    draftOrderCreate: { draftOrder: { id: string; name: string } | null };
  }>(CREATE_DRAFT_ORDER_MUTATION, {
    input: {
      customerId: input.customerId,
      note2: input.note,
      tags: input.tags,
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

  const draftOrder = data.draftOrderCreate.draftOrder;
  if (!draftOrder) {
    throw new Error("Shopify did not return a created draft order");
  }

  const draftOrderId = draftOrder.id.split("/").pop()!;
  return { draftOrderId };
}
