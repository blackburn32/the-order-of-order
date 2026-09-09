/**
 * Runs synchronously in <head>, before first paint, so the reveal styles in
 * styles.css know whether scripting and motion are available. Everything else
 * on this page loads as a deferred module; only the two classes below have to
 * be settled early enough that nothing flashes in and back out.
 */
(function () {
  var root = document.documentElement;
  root.classList.add("has-js");

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!reduced.matches) root.classList.add("js-motion");

  // Honour a preference changed mid-visit: dropping the class parks every
  // animation, and the modules watch the same query to stop their loops.
  var onChange = function () {
    root.classList.toggle("js-motion", !reduced.matches);
  };
  if (reduced.addEventListener) reduced.addEventListener("change", onChange);
})();
