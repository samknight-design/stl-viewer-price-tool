/* shopify-theme/assets/home-nav.js
   Ported from "Arcane Flame Website Prototype" option-c.html <script> block
   (~lines 808-811): the "nav solidify" scroll listener only.
     var nav = document.getElementById("nav");
     function onScroll(){ nav.classList.toggle("solid", window.scrollY > 24); }
     onScroll(); window.addEventListener("scroll", onScroll, {passive:true});

   The burger open/close toggle below is NOT in the prototype (its .burger
   button had no click handler there) — it's added here to satisfy this
   task's definition of done ("mobile burger reveals the same links"). See
   task-4-report.md for the substitution note. No pricing/calculator logic
   lives in this file; keep it that way.
*/
(function () {
  "use strict";

  document.querySelectorAll(".site-head .nav").forEach(function (nav) {
    /* nav solidify on scroll */
    function onScroll() {
      nav.classList.toggle("solid", window.scrollY > 24);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    /* mobile burger reveal */
    var burger = nav.querySelector(".burger");
    if (!burger) return;
    burger.addEventListener("click", function () {
      var open = nav.classList.toggle("nav--open");
      burger.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });
})();
