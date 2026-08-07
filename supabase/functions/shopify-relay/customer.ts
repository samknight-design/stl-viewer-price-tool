// supabase/functions/shopify-relay/customer.ts
import { shopifyGraphQL } from "./shopify.ts";

export interface FindOrCreateCustomerInput {
  email: string;
  /** Full display name, split best-effort into first/last for Shopify. */
  name: string;
  marketingConsent: boolean;
}

export interface CustomerResult {
  id: string;
}

const FIND_CUSTOMER_QUERY = `
  query FindCustomerByEmail($query: String!) {
    customers(first: 1, query: $query) {
      nodes {
        id
        emailMarketingConsent { marketingState }
      }
    }
  }
`;

const CREATE_CUSTOMER_MUTATION = `
  mutation CreateCustomer($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

const UPDATE_CUSTOMER_CONSENT_MUTATION = `
  mutation UpdateCustomerConsent($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

/** Best-effort split — Shopify wants firstName/lastName, our form only collects one field. */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

function consentInput(marketingConsent: boolean) {
  return {
    marketingState: marketingConsent ? "SUBSCRIBED" : "NOT_SUBSCRIBED",
    marketingOptInLevel: marketingConsent ? "SINGLE_OPT_IN" : null,
    consentUpdatedAt: new Date().toISOString(),
  };
}

/**
 * Finds an existing Shopify customer by email, or creates one. Existing
 * customers are never duplicated (avoids Shopify's "email taken" error on
 * repeat quotes from the same person) and their marketing consent is only
 * ever upgraded (unticked-by-default never downgrades an existing
 * subscription — a customer who already opted in stays opted in even if a
 * later quote form submission doesn't re-tick the box).
 */
export async function findOrCreateCustomer(
  input: FindOrCreateCustomerInput,
): Promise<CustomerResult> {
  const escapedEmail = input.email.replace(/"/g, '\\"');
  const found = await shopifyGraphQL<{
    customers: {
      nodes: Array<{ id: string; emailMarketingConsent: { marketingState: string } | null }>;
    };
  }>(FIND_CUSTOMER_QUERY, { query: `email:"${escapedEmail}"` });

  const existing = found.customers.nodes[0];
  if (existing) {
    const alreadySubscribed = existing.emailMarketingConsent?.marketingState === "SUBSCRIBED";
    if (input.marketingConsent && !alreadySubscribed) {
      await shopifyGraphQL(UPDATE_CUSTOMER_CONSENT_MUTATION, {
        input: { id: existing.id, emailMarketingConsent: consentInput(true) },
      });
    }
    return { id: existing.id };
  }

  const { firstName, lastName } = splitName(input.name);
  const created = await shopifyGraphQL<{
    customerCreate: { customer: { id: string } | null };
  }>(CREATE_CUSTOMER_MUTATION, {
    input: {
      email: input.email,
      firstName,
      lastName,
      emailMarketingConsent: consentInput(input.marketingConsent),
    },
  });

  if (!created.customerCreate.customer) {
    throw new Error("Shopify did not return a created customer");
  }
  return { id: created.customerCreate.customer.id };
}
