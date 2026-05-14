"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { MotionConfig, useReducedMotion } from "motion/react";

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  const prefersReducedMotion = useReducedMotion();

  React.useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-reduced-motion",
      prefersReducedMotion === true,
    );
  }, [prefersReducedMotion]);

  return (
    <MotionConfig reducedMotion="user">
      <NextThemesProvider {...props}>{children}</NextThemesProvider>
    </MotionConfig>
  );
}
