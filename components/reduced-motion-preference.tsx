"use client";

import { useEffect } from "react";
import { useReducedMotion } from "motion/react";

/** Syncs `document.documentElement[data-reduced-motion]` with Motion's hook; CSS lives in globals.css. */
export function ReducedMotionPreference() {
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-reduced-motion",
      prefersReducedMotion === true,
    );
  }, [prefersReducedMotion]);

  return null;
}
