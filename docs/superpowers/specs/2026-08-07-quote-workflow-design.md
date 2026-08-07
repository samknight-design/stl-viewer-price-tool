# Quote request workflow: customers, draft orders, files, GDPR consent

**Date:** 2026-08-07
**Scope:** The over-threshold "custom quote" checkout path only (`supabase/functions/shopify-relay/*`, `js/main.js`'s contact-form step, `shopify-theme/assets/print-calc-*` mirrors of the same). The under-threshold auto-checkout path (adds a priced variant to a real Shopify cart, customer pays via Shopify's own native checkout) is explicitly **unchanged** — Shopify's native checkout already handles GDPR-compliant contact collection and marketing consent for that path.

## Context

The relay's `/checkout` endpoint already branches on `thresholdExceeded`: below it, `createPricedVariant` + real cart checkout (unchanged, out of scope here); at/above it, `createDraftOrder` creates a Shopify draft order and the frontend redirects the browser straight to `result.invoiceUrl` — Shopify's own invoice/payment page. This means today, **every** submission ends with the customer looking at a real payment page, regardless of order size. There is no actual "quote request — we'll review and get back to you" flow, no Shopify customer record is ever created, no consent is captured, and a failed `createDraftOrder` call surfaces only a generic error toast with no diagnostic trail — which is the direct cause of the reported "Request quote button does nothing" bug (the relay call was failing silently from the customer's point of view).

This spec replaces the over-threshold path with a genuine quote-request workflow: capture consent-compliant contact details, create/reuse a real Shopify customer, build a draft order carrying the full breakdown and clickable file links, leave it **unsent** for manual review, and notify the shop owner by email that a new quote landed. Nothing is sent to the customer and no payment page is ever shown for this path.

## Path split (unchanged boundary, restated for clarity)

- **Under threshold:** `createPricedVariant` → add to real Shopify cart → redirect to Shopify's native `/checkout`. No changes.
- **At/over threshold ("quote"):** rebuilt per this spec. Ends on the calculator page itself with a "quote submitted" confirmation — never a payment page.

The frontend already computes `thresholdExceeded` client-side before the contact-form step renders (used today to show/hide the existing custom-quote warning note), so this same flag conditionally renders the new consent UI (below) without an extra round trip.

## Contact form changes (quote path only)

Existing fields (name, email, notes, accuracy-disclaimer checkbox) are unchanged in structure. Two additions, shown **only when `thresholdExceeded` is true**:

1. A line of copy under the email field: *"We'll only use this to send your quote and follow up on your order — it won't be added to any marketing list unless you tick below."*
2. A new checkbox, **unticked by default**: *"Also send me offers and news from Arcane Flame."* Real, freely-given, specific opt-in — not bundled with quote submission, not pre-checked (required for lawful marketing consent under UK GDPR/PECR).

The existing accuracy-disclaimer checkbox (confirms scale/material info) is a separate operational disclaimer, not a consent mechanism — left as-is, still required on both paths.

Client-side state: track the marketing checkbox's boolean value alongside existing form fields; include it in the `/checkout` POST body as `marketingConsent: boolean`.

## Backend: `/checkout` over-threshold branch

Replace the current "create draft order → return invoiceUrl → frontend redirects" sequence with:

1. **Find-or-create customer.** Query Shopify for an existing customer by email (`customers(query: "email:<email>")`, first match). If found, reuse its id; if the incoming `marketingConsent` is `true` and the existing customer's consent is not already `SUBSCRIBED`, update it (never silently downgrade an existing subscription to `false` from an unticked box — only ever upgrades). If not found, `customerCreate` with `firstName`/`lastName` (best-effort split of the single `customerName` field), `email`, and `emailMarketingConsent: { marketingState: marketingConsent ? SUBSCRIBED : NOT_SUBSCRIBED, marketingOptInLevel: SINGLE_OPT_IN, consentUpdatedAt: <now, ISO8601> }`.
2. **Resolve file URLs.** For each line item's `_files_json` entries (already carrying Shopify file GIDs from the existing upload step), do a short follow-up query for each file's resolved download `url` (`GenericFile.url` / `MediaImage.image.url`) before building the draft order. Shopify processes uploaded files asynchronously, so this may need 1–2 short retries (e.g. 500ms apart, small fixed cap — not a long poll) before the URL resolves; if it's still unresolved after retrying, fall back to including the file's Admin GID and filename only (never block quote creation on a slow file-processing step).
3. **Create the draft order**, linked to the resolved customer (`customerId`, not just a bare `email` string), with:
   - One line item per model group (unchanged shape from today), `customAttributes` extended to include the resolved file URLs alongside the existing `_files_json`.
   - `tags: ["quote", "quote-ref:<the _quote_ref value>"]` — searchable in Shopify Admin.
   - `note2` (or the draft order's `note` field) summarizing: quote reference, customer name, and a compact per-group file link list, so the whole quote is human-scannable from the draft order screen alone without having to open every line item's custom attributes.
   - Left **unsent** — no `draftOrderInvoiceSend` call, ever, from this code path. Sending the invoice is a manual action the shop owner takes in Shopify Admin once they've reviewed/edited the order.
4. **Send the notification email** (see below) — best-effort: if it fails, log server-side but do not fail the quote request itself (the draft order already exists and is the source of truth; a failed notification is an inconvenience, not a data-loss event).
5. **Return** `{ mode: "quote", quoteRef, draftOrderId }` (no `invoiceUrl` in the response for this path — the frontend has no use for it and must not redirect anywhere).

## Frontend: response handling

On `mode === "quote"`, do **not** navigate the browser anywhere. Show the existing `order-success-wrap` step (already built, currently used for the `"cart"` path's post-redirect state is N/A — this step exists in the DOM today but the quote path never reaches it because of the eager redirect). Copy on this screen should make clear: *"We'll review your quote and be in touch by email."* — not implying payment already happened.

## Notification email

New relay capability: on successful quote-draft-order creation, send a plain transactional email via Resend to `orders@arcane-flame.com`, containing the quote reference, customer name/email, order total, and a direct `https://admin.shopify.com/store/<shop>/draft_orders/<id>` link. Requires a `RESEND_API_KEY` secret (new, added the same way `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET` were — via the Supabase dashboard's Edge Function Secrets UI) and a verified sending domain/address in Resend (the user sets this up; out of scope for this repo to configure).

## Error handling

- If **customer find/create** fails: abort, return a real error to the frontend (existing error-toast path), nothing is created. Retry-safe (no partial state).
- If **customer succeeds but draft order creation fails**: the customer record persists (harmless — a legitimate contact, not orphaned junk) but no draft order exists. Frontend surfaces a genuine error and the customer can retry; retrying re-finds the same customer by email in step 1 rather than erroring on a duplicate-email `customerCreate` call.
- If **file URL resolution** is slow/fails for some files: quote creation proceeds regardless (per step 2 above) — a slow-processing file must never block a customer's quote from being captured.
- If **notification email** fails: logged, does not fail the request (per step 4 above).

## Data model / API surface changes

- `POST /checkout` request body gains `marketingConsent: boolean` (only meaningful/read on the over-threshold branch).
- `POST /checkout` response for the over-threshold branch changes shape: `{ mode: "quote", quoteRef, draftOrderId }` replaces today's `{ mode: "draft-order", invoiceUrl }`. (The under-threshold `{ mode: "cart", variantId, properties }` shape is unchanged.)
- New Supabase secret: `RESEND_API_KEY`.
- New relay module `customer.ts` for the find-or-create-customer logic, following the existing per-concern file layout (`draftOrder.ts`, `variant.ts`, `files.ts`). New relay module `notify.ts` for the Resend notification email.

## Testing / verification

Relay changes get unit tests following the existing pattern (`draftOrder.test.ts`, `files.test.ts`, etc. — fetch-mocked, dependency-injected per `index.test.ts`'s `RelayDeps`). New coverage needed: customer find-vs-create branching, consent-upgrade-never-downgrade logic, file-URL-resolution retry/fallback, draft order tag/note content, notification-failure-doesn't-fail-request.

Manual verification: submit a real over-threshold test quote end-to-end in the Shopify preview theme, confirm in Shopify Admin that (a) a customer record exists with correct marketing consent state, (b) a draft order exists, linked to that customer, tagged, unsent, with clickable file links in its notes/attributes, (c) the notification email arrives at `orders@arcane-flame.com`, (d) the calculator page shows the success screen with no redirect.

## Out of scope

- Any change to the under-threshold auto-checkout path.
- Building an admin UI beyond Shopify's own Admin (draft orders list, customer profiles) — this spec deliberately routes everything through Shopify's native surfaces rather than building bespoke tooling.
- SMS/phone-based marketing consent — email consent only.
- Retroactively backfilling consent state for any customers created before this change (none exist yet — this is the first version of customer creation in this project).
