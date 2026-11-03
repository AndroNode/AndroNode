import { useEffect, useRef, useState } from "react";
import { motionAllowed } from "../lib/motion";

/**
 * The AndroNode "node companion" symbol, rebuilt from AndroNode_Symbol_Geometry.json.
 * Same silhouette as the supplied SVGs; the eyes are a mask so they can blink once (140 ms)
 * after a deliberate interaction. Static under reduced motion (brand guide p.4).
 */
const OUTLINE = "M0 240 124 108 848 0 1000 136 1000 628 806 628 806 800 0 800Z";
const EYES: [number, number, number, number][] = [
  [194, 292, 230, 110],
  [574, 430, 232, 110],
];

export interface CompanionProps {
  size?: number;
  color?: string;
  /** Change this value to trigger one blink. */
  blinkKey?: unknown;
  title?: string;
  className?: string;
}

let uid = 0;

export default function Companion({ size = 48, color = "currentColor", blinkKey, title, className }: CompanionProps) {
  const [id] = useState(() => `an-eyes-${++uid}`);
  const [blink, setBlink] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!motionAllowed()) return;
    setBlink(true);
    const t = setTimeout(() => setBlink(false), 160);
    return () => clearTimeout(t);
  }, [blinkKey]);

  return (
    <svg
      viewBox="0 0 1000 800"
      width={size}
      height={(size * 800) / 1000}
      className={`${blink ? "is-blinking" : ""} ${className ?? ""}`}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="800">
          <rect width="1000" height="800" fill="white" />
          {EYES.map(([x, y, w, h], i) => (
            <rect key={i} className="blink-eye" x={x} y={y} width={w} height={h} fill="black" />
          ))}
        </mask>
      </defs>
      <path d={OUTLINE} fill={color} mask={`url(#${id})`} />
    </svg>
  );
}
