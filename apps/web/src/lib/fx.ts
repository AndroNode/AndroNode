import { motionAllowed } from "./motion";

/**
 * Site-wide motion layer, driven by data attributes so pages stay plain markup:
 *   data-reveal[="up|left|right|scale"]  fades/slides in when scrolled into view
 *   data-stagger                          staggers the reveal of its direct children
 *   data-split                            splits a heading into words that rise in sequence
 *   data-count="1234" [data-decimals] [data-suffix] [data-prefix]  counts up once visible
 *   data-spotlight                        cursor-following glow (CSS reads --mx/--my)
 *   data-tilt                             gentle 3D tilt toward the cursor
 *   data-magnetic                         buttons that lean toward the cursor
 *   data-parallax="0.15"                  vertical parallax while scrolling
 * Everything is skipped when motion is off; content is never hidden without JavaScript.
 */
type Cleanup = () => void;
let cleanups: Cleanup[] = [];

function on<K extends keyof WindowEventMap>(t: Window, ev: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) {
  t.addEventListener(ev, fn as EventListener, opts);
  cleanups.push(() => t.removeEventListener(ev, fn as EventListener));
}

function splitWords(el: HTMLElement) {
  if (el.dataset.splitDone) return;
  el.dataset.splitDone = "1";
  let i = 0;
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = (child.textContent ?? "").split(/(\s+)/);
        const frag = document.createDocumentFragment();
        for (const part of parts) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.append(document.createTextNode(part)); continue; }
          const outer = document.createElement("span");
          outer.className = "fx-word";
          const inner = document.createElement("span");
          inner.className = "fx-word-in";
          inner.style.transitionDelay = `${80 + i++ * 70}ms`;
          inner.textContent = part;
          outer.append(inner);
          frag.append(outer);
        }
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName !== "BR") walk(child);
    }
  };
  walk(el);
}

function countUp(el: HTMLElement, animate: boolean) {
  const target = Number(el.dataset.count);
  const dec = Number(el.dataset.decimals ?? 0);
  const fmt = (v: number) => `${el.dataset.prefix ?? ""}${v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}${el.dataset.suffix ?? ""}`;
  if (!animate) { el.textContent = fmt(target); return; }
  const t0 = performance.now();
  const dur = 1400;
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 4);
    el.textContent = fmt(target * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function initFx() {
  cleanups.forEach((c) => c());
  cleanups = [];
  const root = document.documentElement;
  const motion = motionAllowed();
  const fine = window.matchMedia("(pointer: fine)").matches;
  root.classList.toggle("fx-motion", motion);

  document.querySelectorAll<HTMLElement>("[data-split]").forEach(splitWords);
  document.querySelectorAll<HTMLElement>("[data-stagger]").forEach((wrap) => {
    [...wrap.children].forEach((c, i) => {
      const el = c as HTMLElement;
      if (!el.hasAttribute("data-reveal")) el.setAttribute("data-reveal", wrap.dataset.stagger || "up");
      el.style.setProperty("--fx-delay", `${i * 80}ms`);
    });
  });

  // Inner pages: content blocks below the hero rise in without per-page markup.
  document.querySelectorAll<HTMLElement>("main > section:not(:first-child), main > div:not(:first-child)").forEach((el) => {
    if (!el.hasAttribute("data-reveal") && !el.querySelector("[data-reveal],[data-split],[data-stagger]")) el.setAttribute("data-reveal", "up");
  });

  const targets = document.querySelectorAll<HTMLElement>("[data-reveal],[data-split],[data-count],[data-draw]");
  if (!motion) {
    targets.forEach((el) => { el.classList.add("in"); if (el.dataset.count) countUp(el, false); });
  } else {
    root.classList.add("fx-ready");
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        el.classList.add("in");
        if (el.dataset.count && !el.dataset.counted) { el.dataset.counted = "1"; countUp(el, true); }
        io.unobserve(el);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0 });
    // Hold the reveals until the first-visit intro opens, so the hero animates in front of the visitor.
    const intro = document.getElementById("an-intro");
    const start = () => targets.forEach((el) => io.observe(el));
    if (intro && !intro.hidden) {
      const go = () => setTimeout(start, 120); // the hero animates in while the intro dissolves
      window.addEventListener("an-intro-done", go, { once: true });
      cleanups.push(() => window.removeEventListener("an-intro-done", go));
    } else start();
    cleanups.push(() => io.disconnect());
  }

  // Scroll progress bar and parallax.
  const bar = document.getElementById("fx-progress");
  const par = [...document.querySelectorAll<HTMLElement>("[data-parallax]")];
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const h = document.documentElement.scrollHeight - window.innerHeight;
      if (bar) bar.style.transform = `scaleX(${h > 0 ? window.scrollY / h : 0})`;
      if (motion) for (const el of par) {
        const r = el.getBoundingClientRect();
        const mid = r.top + r.height / 2 - window.innerHeight / 2;
        el.style.transform = `translate3d(0, ${(-mid * Number(el.dataset.parallax || 0.15)).toFixed(1)}px, 0)`;
      }
    });
  };
  on(window, "scroll", onScroll, { passive: true });
  onScroll();

  if (!motion || !fine) return;

  // Spotlight and cursor glow use one delegated listener, so React islands that render later get it too.
  const glow = document.getElementById("fx-cursor");
  let gx = innerWidth / 2, gy = innerHeight / 2, tx = gx, ty = gy, glowRaf = 0;
  const glowTick = () => {
    gx += (tx - gx) * 0.12; gy += (ty - gy) * 0.12;
    if (glow) glow.style.transform = `translate3d(${gx.toFixed(1)}px, ${gy.toFixed(1)}px, 0)`;
    glowRaf = Math.abs(tx - gx) + Math.abs(ty - gy) > 0.5 ? requestAnimationFrame(glowTick) : 0;
  };
  const onMove = (e: PointerEvent) => {
    tx = e.clientX; ty = e.clientY;
    if (glow) { glow.classList.add("on"); if (!glowRaf) glowRaf = requestAnimationFrame(glowTick); }
    const el = (e.target as Element | null)?.closest?.("[data-spotlight]") as HTMLElement | null;
    if (el) {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    }
  };
  on(window, "pointermove", onMove, { passive: true });
  const leaveDoc = () => glow?.classList.remove("on");
  document.documentElement.addEventListener("pointerleave", leaveDoc);
  cleanups.push(() => { document.documentElement.removeEventListener("pointerleave", leaveDoc); cancelAnimationFrame(glowRaf); glow?.classList.remove("on"); });

  document.querySelectorAll<HTMLElement>("[data-tilt]").forEach((el) => {
    const max = Number(el.dataset.tilt || 6);
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `perspective(900px) rotateX(${(-y * max).toFixed(2)}deg) rotateY(${(x * max).toFixed(2)}deg) translateZ(0)`;
    };
    const leave = () => { el.style.transform = ""; };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    cleanups.push(() => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerleave", leave); });
  });

  document.querySelectorAll<HTMLElement>("[data-magnetic]").forEach((el) => {
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - (r.left + r.width / 2);
      const y = e.clientY - (r.top + r.height / 2);
      el.style.transform = `translate(${(x * 0.18).toFixed(1)}px, ${(y * 0.28).toFixed(1)}px)`;
    };
    const leave = () => { el.style.transform = ""; };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    cleanups.push(() => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerleave", leave); });
  });
}
