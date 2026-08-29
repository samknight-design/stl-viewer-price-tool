/* shopify-theme/assets/home-craft.js
   NOT ported from the prototype — option-c.html has no JS for `.pin` at all;
   it hides pins outright on touch devices (`@media (hover:none){ .pin{display:
   none} }`, home-craft.css) with no tap fallback. Added here per code review
   on task 8 to satisfy the brief's actual definition of done ("hover/tap
   reveals each pin label"), not just to disclose the gap.

   Minimal tap-to-toggle: click/tap a `.pin` to add `is-open` (home-craft.css
   shows `.pin__lbl` under `.pin.is-open` the same as `:hover`, and unhides
   the pin itself inside the `@media (hover:none)` block). Tapping a second
   pin closes the first. Tapping anywhere else in the section closes whichever
   pin is open. Works as a harmless no-op fallback on mouse/pointer devices
   too (click toggles the same class hover already reveals via CSS).

   Scope is deliberately narrow: pin open/close state only. No calculator or
   pricing logic belongs in this file. */
(function () {
  "use strict";

  document.querySelectorAll(".craft__fig").forEach(function (fig) {
    var pins = fig.querySelectorAll(".pin");

    function closeAll(except) {
      pins.forEach(function (pin) {
        if (pin !== except) pin.classList.remove("is-open");
      });
    }

    pins.forEach(function (pin) {
      pin.addEventListener("click", function (e) {
        var wasOpen = pin.classList.contains("is-open");
        closeAll(pin);
        pin.classList.toggle("is-open", !wasOpen);
        e.stopPropagation();
      });
    });

    document.addEventListener("click", function (e) {
      if (!fig.contains(e.target)) closeAll(null);
    });
  });
})();
