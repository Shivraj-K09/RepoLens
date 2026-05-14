"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useReducedMotion } from "motion/react";

import { PREFERS_REDUCED_MOTION_MEDIA_QUERY } from "@/lib/a11y/wcag-motion";

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  const prefersReducedMotion = useReducedMotion();

  React.useEffect(() => {
    void PREFERS_REDUCED_MOTION_MEDIA_QUERY;
    document.documentElement.toggleAttribute(
      "data-reduced-motion",
      prefersReducedMotion === true,
    );
  }, [prefersReducedMotion]);

  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
