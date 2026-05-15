import { LandingShell } from "@/components/landing/landing-shell";
import { landingAuthFromUser } from "@/lib/auth/landing-auth";
import { fetchRecentRepoVisitSidebar } from "@/lib/supabase/repo-visit-history";
import { createClient } from "@/lib/supabase/server";

export default async function WwwLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const auth = user ? landingAuthFromUser(user) : null;
  const repoVisitHistory =
    user != null ? await fetchRecentRepoVisitSidebar(supabase, user.id) : [];

  return (
    <LandingShell auth={auth} repoVisitHistory={repoVisitHistory}>
      {children}
    </LandingShell>
  );
}
