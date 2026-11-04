import { useEffect, useRef, useState } from "react";
import { useMotion } from "../lib/motion";
import type { SceneHandle } from "../lib/scene/constellation";

/**
 * Mounts the 3D device constellation. Three.js loads only when this island is visible,
 * pauses off-screen, and holds still when motion is off. Without WebGL the CSS backdrop remains.
 */
export default function HeroScene() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<SceneHandle | null>(null);
  const motion = useMotion();
  const [ready, setReady] = useState(false);
  const motionRef = useRef(motion);
  motionRef.current = motion;

  useEffect(() => {
    let cancelled = false;
    const el = canvas.current;
    if (!el) return;
    const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
    if (!gl) return;
    import("../lib/scene/constellation").then(async ({ createConstellation }) => {
      if (cancelled || !canvas.current) return;
      const h = await createConstellation(canvas.current, { motion, compact: window.innerWidth < 768 });
      if (cancelled) return h.dispose();
      handle.current = h;
      h.setMotion(motionRef.current); // motion may have changed while the scene was being built
      requestAnimationFrame(() => setReady(true));
    });
    const onScroll = () => {
      const r = el.getBoundingClientRect();
      handle.current?.setScroll(Math.max(0, -r.top) / Math.max(1, r.height));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelled = true;
      window.removeEventListener("scroll", onScroll);
      handle.current?.dispose();
      handle.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => handle.current?.setMotion(motion), [motion]);

  return (
    <canvas
      ref={canvas}
      aria-hidden="true"
      className={`absolute inset-0 h-full w-full transition-opacity duration-[1400ms] ease-out ${ready ? "opacity-100" : "opacity-0"}`}
    />
  );
}
