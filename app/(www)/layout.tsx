import {
  LandingShell,
  type LandingAuthorLinks,
} from "@/components/landing/landing-shell";
import { landingAuthFromUser } from "@/lib/auth/landing-auth";
import { createClient } from "@/lib/supabase/server";

function authorLinks(): LandingAuthorLinks {
  return {
    github: process.env.NEXT_PUBLIC_AUTHOR_GITHUB_URL?.trim() ?? "",
    linkedIn: process.env.NEXT_PUBLIC_AUTHOR_LINKEDIN_URL?.trim() ?? "",
  };
}

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

  return (
    <LandingShell auth={auth} author={authorLinks()}>
      {children}
    </LandingShell>
  );
}
