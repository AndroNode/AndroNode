import { getItem, setItem } from "./storage";

export type MotionPref = "on" | "off" | "system";
const KEY = "an-motion";

export function motionPref(): MotionPref {
  const v = getItem(KEY);
  return v === "on" || v === "off" ? v : "system";
}

export function motionAllowed(): boolean {
  if (typeof window === "undefined") return false;
  const p = motionPref();
  if (p === "off") return false;
  if (p === "on") return true;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function setMotion(p: MotionPref) {
  setItem(KEY, p);
  if (p === "system") document.documentElement.removeAttribute("data-motion");
  else document.documentElement.setAttribute("data-motion", p);
  window.dispatchEvent(new CustomEvent("an-motion", { detail: p }));
}
