"use client";

import { LandingShellInset } from "@/components/landing/landing-shell-inset";
import { LandingShellSidebar } from "@/components/landing/landing-shell-sidebar";
import type { LandingAuthorLinks } from "@/components/landing/landing-shell-types";
import type { LandingAuthSnapshot } from "@/lib/auth/landing-auth";
import type { SidebarRepoVisit } from "@/lib/supabase/repo-visit-history";
import { SidebarProvider } from "@/components/ui/sidebar";

export type { LandingAuthorLinks } from "@/components/landing/landing-shell-types";

type LandingShellProps = {
  auth: LandingAuthSnapshot | null;
  author: LandingAuthorLinks;
  /** Recent repo visits (SSR); empty until user opens repos. */
  repoVisitHistory: SidebarRepoVisit[];
  children: React.ReactNode;
};

export function LandingShell({
  auth,
  author,
  repoVisitHistory,
  children,
}: LandingShellProps) {
  return (
    <SidebarProvider defaultOpen>
      <LandingShellSidebar
        auth={auth}
        author={author}
        repoVisitHistory={repoVisitHistory}
      />
      <LandingShellInset>{children}</LandingShellInset>
    </SidebarProvider>
  );
}
