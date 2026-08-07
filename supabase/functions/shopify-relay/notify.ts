// supabase/functions/shopify-relay/notify.ts

export interface QuoteNotificationInput {
  quoteRef: string;
  customerName: string;
  customerEmail: string;
  grandTotal: number;
  /** Numeric Shopify draft order id (not the full GID). */
  draftOrderId: string;
}

function adminDraftOrderUrl(draftOrderId: string): string {
  const storeDomain = Deno.env.get("SHOPIFY_STORE_DOMAIN") ?? "";
  const storeHandle = storeDomain.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${storeHandle}/draft_orders/${draftOrderId}`;
}

/**
 * Emails the shop owner that a new quote draft order was created. Shopify
 * does not do this automatically for API-created draft orders (only for
 * merchant-sent invoices), so without this the shop owner has no signal
 * that a quote is waiting for review. Best-effort: never throws — a failed
 * notification must not fail the quote request itself, since the draft
 * order (the actual source of truth) already exists by the time this runs.
 */
export async function sendQuoteNotification(input: QuoteNotificationInput): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set — skipping quote notification email");
    return;
  }

  const toEmail = Deno.env.get("NOTIFY_TO_EMAIL") ?? "orders@arcane-flame.com";
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") ?? "quotes@arcane-flame.com";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: `New quote request ${input.quoteRef} — £${input.grandTotal.toFixed(2)}`,
        text: [
          `New quote from ${input.customerName} (${input.customerEmail})`,
          "",
          `Reference: ${input.quoteRef}`,
          `Total: £${input.grandTotal.toFixed(2)}`,
          "",
          "Review and send the invoice here:",
          adminDraftOrderUrl(input.draftOrderId),
        ].join("\n"),
      }),
    });
    if (!res.ok) {
      console.error(`Resend notification failed: HTTP ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error("Resend notification failed:", err);
  }
}
