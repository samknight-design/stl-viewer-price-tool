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

type FoundCustomer = { id: string; emailMarketingConsent: { marketingState: string } | null };

async function findCustomerByEmail(email: string): Promise<FoundCustomer | null> {
  const escapedEmail = email.replace(/"/g, '\\"');
  const found = await shopifyGraphQL<{ customers: { nodes: FoundCustomer[] } }>(
    FIND_CUSTOMER_QUERY,
    { query: `email:"${escapedEmail}"` },
  );
  return found.customers.nodes[0] ?? null;
}

async function upgradeConsentIfNeeded(customer: FoundCustomer, marketingConsent: boolean): Promise<void> {
  const alreadySubscribed = customer.emailMarketingConsent?.marketingState === "SUBSCRIBED";
  if (marketingConsent && !alreadySubscribed) {
    await shopifyGraphQL(UPDATE_CUSTOMER_CONSENT_MUTATION, {
      input: { id: customer.id, emailMarketingConsent: consentInput(true) },
    });
  }
}

// Shopify's customer search index can lag a moment behind writes, so a
// customer created moments ago (e.g. by an earlier quote from the same
// person) may not show up in FIND_CUSTOMER_QUERY yet, causing
// customerCreate to fail with "Email has already been taken" below. Retry
// the find with backoff instead of failing the whole quote in that case.
const EMAIL_TAKEN_RETRY_DELAYS_MS = [500, 1000];

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
  const existing = await findCustomerByEmail(input.email);
  if (existing) {
    await upgradeConsentIfNeeded(existing, input.marketingConsent);
    return { id: existing.id };
  }

  const { firstName, lastName } = splitName(input.name);
  try {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already been taken/i.test(message)) throw err;

    for (const delayMs of EMAIL_TAKEN_RETRY_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const retryFound = await findCustomerByEmail(input.email);
      if (retryFound) {
        await upgradeConsentIfNeeded(retryFound, input.marketingConsent);
        return { id: retryFound.id };
      }
    }
    throw err;
  }
}
