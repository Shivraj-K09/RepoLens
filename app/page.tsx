import { HomeLanding } from "@/components/landing/home-landing";
import { landingAuthFromUser } from "@/lib/auth/landing-auth";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const auth = user ? landingAuthFromUser(user) : null;

  return <HomeLanding auth={auth} />;
}
