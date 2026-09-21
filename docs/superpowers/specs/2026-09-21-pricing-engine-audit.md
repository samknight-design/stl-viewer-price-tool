# Pricing Engine Spec — Phase 1 Audit

Audit of `pricing-engine-spec.md` (2026-09-21) against the live tool.
No code written, per §0.

**Verdict: the pricing model itself is sound and worth building.** I reproduced
all nine acceptance tests from the stated constants; seven match exactly and two
are a penny out for a reason I've traced (§A). The maths is well-behaved — no
way to game the discount by padding an order.

But the spec was written against an out-of-date picture of the tool, and as
written it would silently delete five pricing features that are live and earning
today. There are six decisions to settle before anyone writes code. None of them
is a reason to abandon the spec.

---

## A. The acceptance tests

I implemented §2 literally and ran §8.

| # | Order | Spec | Computed |
|---|---|---|---|
| 1 | 1 × resin 3.5 ml | £6.00 | £6.00 ✓ |
| 2 | 1 × resin 45.05 ml | £35.04 | **£35.03** |
| 3 | 1 × resin 0.03 ml | £5.00 | £5.00 ✓ |
| 4 | 4 × resin 3.5 ml | £22.93 | £22.93 ✓ |
| 5 | 200 × resin 0.03 ml | £168.21 | £168.21 ✓ |
| 6 | 1 × 45.05 + 2 × 3.5 resin | £46.50 | **£46.49** |
| 7 | 1 × resin 3.5 ml @ 200% | £24.94 | £24.94 ✓ |
| 8 | 1 × PLA 50 ml | £6.06 | £6.06 ✓ |
| 9 | 1 × PLA 1 ml | £5.00 | £5.00 ✓ |

Test 5's per-rank breakdown (£0.87 / £0.86 / £0.85 / £0.84) reproduces exactly,
which is a good sign the bracket logic is unambiguous.

**Tests 2 and 6 are the same part.** At full double precision,
`0.71 + 2.114 × 45.05^0.732 = 35.03492`, which rounds to £35.03. To get £35.04
you have to round the power term to five significant figures mid-calculation
(`45.05^0.732 → 16.237`), which lands on £35.035018 and rounds up. The true
value misses the rounding boundary by 0.008 of a penny.

So it is an artefact of how the example was worked out, not a flaw in the model.
**Decision needed:** confirm that no intermediate rounding happens — only the
final per-part price is rounded, as §2.4 says — and correct the two expected
values to £35.03 and £46.49. Worth settling now, because otherwise the unit
tests fail on day one and the temptation will be to nudge a constant to fit.

**Anti-gaming holds.** I checked that adding any part to any order always
increases the total — the worst case across hundreds of combinations was +£0.84.
Adding an expensive part does push cheaper parts into better brackets, but never
by enough to outrun what the new part costs. The most-expensive-first ranking
does what §2.3 claims.

---

## B. Audit answers (§1)

**1. Stack and structure.** Vanilla ES modules, no build step, no framework.
Pricing lives in `js/calculator.js` (engine) and `js/config.js` (constants).
It ships two ways: as a static page, and as Shopify theme assets
(`shopify-theme/assets/print-calc-*.js`, generated from `js/` with renamed
imports). The live code is on the `worktree-shopify-integration` branch, not
`master` — the two have diverged and `master` is stale for these files. Server
side is one stateless Supabase Edge Function, `supabase/functions/shopify-relay`
(Deno/TypeScript), currently at v54.

**2. Price flow to Shopify — this is a critical issue, as the spec anticipated.**
Under £150 the browser POSTs `/checkout`, the relay creates a priced Shopify
product variant and returns its id, and the browser adds it to the cart and
goes to checkout. Over £150 it becomes an Admin API draft order for manual
review instead.

The relay does validate — but only that the submitted `grandTotal` matches the
submitted line items' own prices, and that the £150 threshold can't be cleared
by the client. Both the total *and* the line prices come from the browser. The
server never re-derives a price from the model. A crafted request declaring a
huge model at the £5 minimum is accepted and creates a real variant at that
price; this was confirmed by probe against the live function in August. The
floor is `minimumOrderTotal`, not zero.

This was a known, accepted risk (documented, with the compensating control that
every order is reviewed by hand before printing). The spec's §4 now asks to fix
it properly. See §D below — it is the largest piece of work in the spec.

**3. File storage.** The browser asks the relay for a signed upload URL, then
PUTs the bytes **straight to Supabase Storage**. The relay never sees the file —
deliberately, because Shopify's Files API caps at 20 MB and real STLs exceed
that. Bucket `quote-uploads`, 50 MB per-file limit, **public**, with no MIME
restriction configured. So today the server has never parsed an STL, though it
can reach every uploaded file by URL.

Two things for §4's validation requirement: the bucket being public means any
uploaded file is readable by anyone with the link, and `allowed_mime_types` is
null, so "STL only" is not currently enforced anywhere but the browser.

**4. Admin panel security — better than the spec assumes.** The password is
*not* checked in client-side JS. `js/admin.js` verifies it by calling the
relay's `POST /config`, which compares against an `ADMIN_PASSWORD` secret
server-side; settings live in a Shopify shop metafield
(`print_calculator.pricing_config`), not the browser. localStorage holds only a
last-known-good cache for when the relay is unreachable.

The real problem with the admin panel is different: **it is stale.** Its form
fields belong to the pre-July pricing model (cost per mL, machine hourly rate,
print speed, markup) and it cannot edit anything that currently drives a price —
not the size tiers, primer tiers, extras, surcharges or thresholds. Note also
that merely logging in performs a save, so opening it writes whatever the form
is showing back to the shop. Since §5 requires every new constant to be
admin-editable, **the admin panel has to be rebuilt as part of this work.** The
spec doesn't budget for that.

**5. Mesh handling.** Custom parser, no library: `js/stl-parser.js` reads binary
and ASCII STL into a flat `Float32Array` (9 floats per triangle). Volume is the
standard divergence-theorem tetrahedron sum — but it takes `Math.abs()` of the
*whole model's* total, so a flipped shell silently cancels against a good one
rather than being caught.

**Vertices are not welded in the pricing path.** Volume is computed straight
from triangle soup. Welding exists only in the viewer (`js/viewer.js` uses
three.js `mergeVertices`, tolerance 0.05 mm) for display normals. The spec asks
for 1e-4 mm, 500× tighter. three.js and `mergeVertices` are already available
in the browser, which helps — but not in the relay, which has no three.js.

There is no connected-component splitting anywhere today. Every file is one
part, priced once.

**6. Scale and quantity.** Scale is a number input, not a slider: min 0.1, max
10, step 0.05, stored per **part** as `item.settings.scale`. Quantity is also
per part, `item.settings.quantity`, min 1, max 999. Note the spec says "the
file's quantity" and "the scale slider" — both are per-part in the tool, and a
"model" is a group containing several parts. Worth aligning the vocabulary
before building, because §2.3 step 1 ("each body of each file, repeated for that
file's quantity") has to map onto the group → part → detected-body hierarchy.

---

## C. What the spec would delete without saying so

§0 says the spec replaces "volume × material cost + support % + flat labour +
margin %", and §5 says to replace "cost per cm³, support %, flat labour, margin
%". **That is the pricing model from before 30 July 2026.** It was thrown out
two months ago and replaced by fixed size tiers. So the spec is arguing against
a version of the tool that no longer exists.

This matters because §5's "replace the old settings" list doesn't mention five
things that are live, priced, and visible in the UI today:

| Feature | Current behaviour | Spec says |
|---|---|---|
| **Primer** | £0.50–£20 by volume tier, per model | nothing |
| **Assembly** | £5 first joint, £3.50 each extra, £40 cap | nothing |
| **Extras** | Wings £3, Sword £1.50, Shield £1.50, Banner £2.50 | nothing |
| **Resin surcharges** | Tough +15%, Flexible +20%, Castable +25%, Dental +35% | nothing |
| **£150 custom-quote threshold** | routes to manual draft order | nothing |
| PLA colour surcharge | +10% standard, +20% metallic/pearl | removed (§2.2, §9) |

Only the last one is a deliberate removal. The other five are simply absent.
You've already told me the £150 threshold must stay. My assumption unless you
say otherwise: **primer, assembly, extras and resin surcharges all stay exactly
as they are**, and the new volume model replaces only the per-part base price
(what `calcSizeTier` does today). That keeps the change surgical.

Two more things the spec drops that are load-bearing:

- **The build-plate fit check.** Today a model that physically won't fit the
  printer (211×118×220 mm, less a 20% support margin) can't be priced at all and
  is blocked at checkout. Volume alone can't catch this — a 400 mm sword is only
  a few ml. This check must survive independently of pricing.
- **The pre-supported vs standard distinction** (8% size inflation + 40% support
  handling fee). Under volume pricing a pre-supported file's supports are real
  volume and get charged for, which arguably self-corrects — but it means
  pre-supported files get *more* expensive than bare ones, the opposite of
  today's incentive. Needs a deliberate decision, not a side effect.

---

## D. Server-side pricing (§4) — the big one

This is the right thing to want, and it's the single largest item in the spec.
It means the relay must parse STLs, which it has never done. I benchmarked the
full §3 pipeline (parse → weld at 1e-4 → union-find split → per-component
signed volume) in Node on real files:

| File | Size | Triangles | Components | > 0.005 ml | Time | Peak RSS |
|---|---|---|---|---|---|---|
| `stltestfrom site.stl` | 17 MB | 358 k | 1 | 1 | 0.44 s | 130 MB |
| `Armour_Back.stl` | 80 MB | 1.68 M | 13 | **1** | 2.05 s | — |
| `15-01-26 v2.stl` | 606 MB | 12.7 M | 9,126 | **1,542** | 17.2 s | — |

Encouraging: welding and splitting are cheap and correct, and the debris
threshold earns its keep immediately — `Armour_Back` splits into 13 components
but 12 are zero-volume slivers, leaving exactly one real part.

Two concerns:

1. **Memory.** 130 MB resident for a 17 MB file, roughly 7–8× the file size.
   The bucket allows 50 MB uploads, which extrapolates to ~380 MB — above the
   256 MB an edge function gets. A 50 MB STL would likely OOM the relay. Either
   the bucket limit comes down, or parsing moves somewhere with more headroom,
   or the parser streams instead of holding everything at once. **This needs
   settling before the architecture is chosen.**
2. **Time.** Sub-second for typical files is fine. The 606 MB file at 17 s is
   beyond what could be uploaded today anyway, but it shows the shape.

Worth noting the cheaper middle option: keep pricing in the browser for the live
estimate, and have the relay re-derive the price server-side *only* at checkout,
from the file already in storage. That's one parse per order rather than one per
upload, and it fully closes the tamper hole. I'd recommend that over parsing on
every upload.

---

## E. Intersecting shells (§7.1) — recommendation

The spec asks me to recommend an approach. That 606 MB file is the warning shot:
**1,542 components above the debris threshold × £0.71 handling = £1,095 in
handling fees alone**, before a single ml is priced. It would trip the 30-part
review flag, but §3 still says to quote it. A customer would see four figures
for one file.

Neither option in §7.1 is good on its own. True mesh–mesh intersection is
accurate but expensive and fiddly to get right. Bounding-box overlap is cheap
but wrong in exactly the common case — a sprue of separate bits on one plate all
share overlapping boxes and would merge into one part, undercharging badly.

**What I'd recommend instead: stop charging `B` per detected body.** The
handling fee exists to cover real per-part handling — washing, curing,
de-supporting, packing — which tracks the number of *pieces you actually handle*,
not the number of disconnected shells in a mesh. Options, cheapest first:

- Charge `B` once per uploaded file, plus the volume term over the file's total
  volume. Splitting is then only needed for cavity handling and review flags, and
  the whole §7.1 risk evaporates.
- Or keep `B` per part but cap it (e.g. no more than N × B per file), so a
  shell-soup export can't run away.
- Or keep it per part and have anything over the review threshold go to manual
  quote rather than showing a number.

If you do want true per-part handling fees, then merging has to be real geometry
work, and I'd want to prototype it against your test files before committing to
a build. That's a meaningful chunk of work on its own.

---

## F. What the new prices actually look like

Real files, current live price vs the new model, for a single unsupported part
(excluding primer, assembly, extras, surcharges, and the £5 minimum):

| File | Dimensions | Volume | Now | New | Change |
|---|---|---|---|---|---|
| `stltestfrom site.stl` | 47×44×39 mm | 5.27 ml | £8.40 | £7.85 | −7% |
| `Armour_Back.stl` | 23×39×8 mm | 0.68 ml | £4.20 | £2.31 | −45% |
| `Light Grommet.STL` | 17×17×14 mm | 1.09 ml | £1.40 | £2.95 | +111% |

The pattern: **volume pricing rewards hollow, flat and sparse models and
penalises dense, chunky ones** — the exact reverse of dimension pricing. Which
direction any given model moves depends entirely on how solid it is inside its
bounding box, and that's not something I can predict for your catalogue.

I also modelled eight typical model types, but the volumes there were my
assumptions rather than measurements, and they skewed dense enough to suggest
across-the-board increases of 40–240%. I don't trust that enough to report it as
a finding. **Before committing: run your ten or twenty most common real files
through both models and check the totals are where you want them.** The
constants are admin-editable, so calibration is easy — but it should happen
against real files, not guesses.

---

## G. Decisions needed before building

1. **Rounding:** confirm no intermediate rounding, and correct tests 2 and 6 to
   £35.03 and £46.49.
2. **Keep or drop:** primer, assembly, extras, resin surcharges. My assumption
   is keep all four unchanged. The £150 threshold stays — you've confirmed that.
3. **Per-part handling fee:** per detected body (needs real shell merging), or
   per file (kills the §7.1 risk outright)? See §E.
4. **Pre-supported vs standard:** what replaces the current 8% / 40% mechanism
   now that supports are just volume?
5. **Server-side pricing:** at checkout only (recommended), or on every upload?
   And resolve the 50 MB upload vs 256 MB function-memory conflict.
6. **Admin panel:** it must be rebuilt to edit the new constants. Confirm that's
   in scope — the spec requires it but doesn't budget for it.

Also worth doing regardless: restrict the `quote-uploads` bucket MIME types, and
decide whether it should stay public.

---

## H. Test files still needed

§7 asks for these and they aren't on hand: a Hero Forge mini, a
Patreon/MyMiniFactory mini with a separate base, a 40K bits file with several
parts, a hollowed model, and a tiny part (~0.03 ml). The Hero Forge one matters
most — it's the case §7.1 is really about. Add a couple of your best-selling
real files for the §F calibration check.
