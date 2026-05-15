"use client";

import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

export type LandingShellInsetProps = {
  children: ReactNode;
};

export function LandingShellInset({ children }: LandingShellInsetProps) {
  return (
    <SidebarInset
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden bg-background",
      )}
    >
      <header className="flex shrink-0 items-center gap-2 bg-background px-3 py-2 md:hidden">
        <SidebarTrigger className="text-foreground" />
        <span className="text-sm font-semibold tracking-tight">
          <span className="text-foreground">Repo</span>
          <span className="text-muted-foreground">Lens</span>
        </span>
      </header>
      <div className="scrollbar-hide flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </SidebarInset>
  );
}
