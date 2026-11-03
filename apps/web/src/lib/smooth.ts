import Lenis from "lenis";
import { motionAllowed } from "./motion";

/**
 * Smooth, inertial wheel scrolling for the whole site (Lenis). It keeps native scrolling underneath,
 * so sticky sections, IntersectionObservers and scroll listeners keep working. Touch keeps the
 * device's own scrolling. It is off when motion is off, and paused while the homepage intro plays.
 */
let lenis: Lenis | null = null;
let raf = 0;

declare global {
  interface Window { __lenis?: Lenis | null }
}

function loop(t: number) {
  lenis?.raf(t);
  raf = requestAnimationFrame(loop);
}

function start() {
  if (lenis) return;
  lenis = new Lenis({
    duration: 1.15,
    easing: (x) => Math.min(1, 1.001 - Math.pow(2, -10 * x)),
    smoothWheel: true,
    wheelMultiplier: 1,
    anchors: { offset: -96 },
    // Let inner scroll areas (logs, tables, the docs index) scroll on their own.
    prevent: (node) => node.closest?.("[data-lenis-prevent], .overflow-auto, .overflow-x-auto, .overflow-y-auto, dialog") != null,
  });
  window.__lenis = lenis;
  raf = requestAnimationFrame(loop);
}

function stop() {
  cancelAnimationFrame(raf);
  lenis?.destroy();
  lenis = null;
  window.__lenis = null;
}

export function initSmoothScroll() {
  const sync = () => (motionAllowed() ? start() : stop());
  sync();
  window.addEventListener("an-motion", sync);

  // Hold still while the intro covers the page.
  const intro = document.getElementById("an-intro");
  if (lenis && intro && !intro.hidden) {
    lenis.stop();
    window.addEventListener("an-intro-done", () => lenis?.start(), { once: true });
  }

  // Page changes: start each new page at the top (or at its hash), and pick up the new page height.
  document.addEventListener("astro:after-swap", () => {
    if (!lenis) return;
    lenis.resize();
    if (!location.hash) lenis.scrollTo(0, { immediate: true, force: true });
  });
}

/** Scroll to an element smoothly, through Lenis when it is running. */
export function smoothScrollTo(el: Element, offset = -96) {
  if (lenis) lenis.scrollTo(el as HTMLElement, { offset });
  else el.scrollIntoView({ behavior: motionAllowed() ? "smooth" : "auto", block: "start" });
}
