"use client";

import { LandingShellInset } from "@/components/landing/landing-shell-inset";
import { LandingShellSidebar } from "@/components/landing/landing-shell-sidebar";
import type { LandingAuthSnapshot } from "@/lib/auth/landing-auth";
import type { SidebarRepoVisit } from "@/lib/supabase/repo-visit-history";
import { SidebarProvider } from "@/components/ui/sidebar";

type LandingShellProps = {
  auth: LandingAuthSnapshot | null;
  /** Recent repo visits (SSR); empty until user opens repos. */
  repoVisitHistory: SidebarRepoVisit[];
  children: React.ReactNode;
};

export function LandingShell({
  auth,
  repoVisitHistory,
  children,
}: LandingShellProps) {
  return (
    <SidebarProvider defaultOpen>
      <LandingShellSidebar
        auth={auth}
        repoVisitHistory={repoVisitHistory}
      />
      <LandingShellInset>{children}</LandingShellInset>
    </SidebarProvider>
  );
}
